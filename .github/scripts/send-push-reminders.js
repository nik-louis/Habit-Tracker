// Scheduled by .github/workflows/push-reminders.yml every ~10 minutes. This is the ONLY piece of
// this app that runs on a server at all — everything else is a build-free single HTML file. It
// exists because no client-side code can wake itself up at a future time when the tab is fully
// closed; a real Web Push message has to be sent by something outside the browser.
//
// This script is shared across every installation using this repo, so it never sees anyone's
// encryption password and therefore never sees decrypted habit data — it only reads whatever the
// client deliberately mirrors in the clear under /sync/{code}/push/{deviceId} (see
// pushRemindersProjection() in index.html): reminder SCHEDULE only (type/time/days/count/from/to),
// never title text or habit names. The push body is always a fixed, generic string chosen from the
// device's mirrored `lang`.
//
// Reminder types that depend on live habit-completion state (untilDone; a habit-bound smart
// reminder) are never mirrored by the client in the first place, so they never reach isDue() below —
// they keep working normally through the app's own in-page checkReminders() whenever it happens to
// be open, just without a push backup while closed.
const webpush = require("web-push");

const DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
const SYNC_CODE = process.env.FIREBASE_SYNC_CODE || "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:push@example.com";

const GENERIC = {
  ru: { title: "⏰ Habitunity", body: "Пора отметить привычки" },
  en: { title: "⏰ Habitunity", body: "Time to check in" },
  es: { title: "⏰ Habitunity", body: "Hora de revisar tus hábitos" },
  zh: { title: "⏰ Habitunity", body: "该打卡习惯了" },
  fr: { title: "⏰ Habitunity", body: "C'est l'heure de cocher tes habitudes" },
};

function minOfDay(hm) {
  const [h, m] = String(hm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Mirrors index.html's checkReminders() matching logic exactly, for the reminder types the client
// actually mirrors here (time/daily/weekly/smart — see pushRemindersProjection()).
function isDue(r, nowMin, dow, dayKey, lf) {
  if (r.type === "time") return nowMin >= minOfDay(r.time) && lf.once !== true;
  if (r.type === "daily") return nowMin >= minOfDay(r.time) && lf.day !== dayKey;
  if (r.type === "weekly") return (r.days || []).includes(dow) && nowMin >= minOfDay(r.time) && lf.day !== dayKey;
  if (r.type === "smart") {
    const from = minOfDay(r.from || "10:00"), to = minOfDay(r.to || "21:00"), cnt = Math.max(1, r.count || 3);
    if (to <= from) return false;
    const step = (to - from) / cnt;
    const slots = []; for (let i = 0; i < cnt; i++) slots.push(Math.round(from + step * i));
    const idx = lf.smartDay === dayKey ? (lf.smartIdx || 0) : 0;
    return idx < slots.length && nowMin >= slots[idx];
  }
  return false;
}

function advance(r, dayKey, lf) {
  const nf = Object.assign({}, lf);
  if (r.type === "time") nf.once = true;
  else if (r.type === "daily" || r.type === "weekly") nf.day = dayKey;
  else if (r.type === "smart") {
    const idx = lf.smartDay === dayKey ? (lf.smartIdx || 0) : 0;
    nf.smartDay = dayKey; nf.smartIdx = idx + 1;
  }
  return nf;
}

async function run() {
  if (!DB_URL || !SYNC_CODE || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log("Push reminders: required secrets not configured yet — skipping (this is expected until Cloud Sync + VAPID secrets are set up).");
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const pushPath = `${DB_URL}/sync/${SYNC_CODE}/push.json`;
  const res = await fetch(pushPath);
  if (!res.ok) { console.log("Push reminders: could not read /push node, status", res.status); return; }
  const devices = await res.json();
  if (!devices || typeof devices !== "object") { console.log("Push reminders: no registered devices."); return; }

  const nowUtcMin = Math.floor(Date.now() / 60000) % 1440;
  const nowUtcMs = Date.now();
  let sent = 0;

  for (const [deviceId, rec] of Object.entries(devices)) {
    if (!rec || !rec.sub || !Array.isArray(rec.reminders) || !rec.reminders.length) continue;
    const tz = typeof rec.tzOffsetMin === "number" ? rec.tzOffsetMin : 0;
    let localMin = (nowUtcMin + tz) % 1440; if (localMin < 0) localMin += 1440;
    const local = new Date(nowUtcMs + tz * 60000);
    const dayKey = `${local.getUTCFullYear()}-${local.getUTCMonth() + 1}-${local.getUTCDate()}`;
    const dow = local.getUTCDay();
    const generic = GENERIC[rec.lang] || GENERIC.ru;

    const lastFiredAll = Object.assign({}, rec.lastFired || {});
    let touched = false, deviceGone = false;

    for (const r of rec.reminders) {
      if (deviceGone) break;
      const lf = lastFiredAll[r.id] || {};
      if (!isDue(r, localMin, dow, dayKey, lf)) continue;
      try {
        await webpush.sendNotification(rec.sub, JSON.stringify({ title: generic.title, body: generic.body, tag: r.id }));
        sent++;
      } catch (e) {
        console.log(`Push failed for device ${deviceId}, reminder ${r.id}:`, e.statusCode || e.message);
        if (e.statusCode === 404 || e.statusCode === 410) {
          // Subscription is dead (uninstalled / expired) — drop the whole device record and move on.
          await fetch(`${DB_URL}/sync/${SYNC_CODE}/push/${deviceId}.json`, { method: "DELETE" }).catch(() => {});
          deviceGone = true;
          break;
        }
      }
      lastFiredAll[r.id] = advance(r, dayKey, lf);
      touched = true;
    }

    if (touched && !deviceGone) {
      await fetch(`${DB_URL}/sync/${SYNC_CODE}/push/${deviceId}/lastFired.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastFiredAll),
      }).catch(() => {});
    }
  }

  console.log(`Push reminders: checked ${Object.keys(devices).length} device(s), sent ${sent} notification(s).`);
}

if (require.main === module) {
  run().catch((e) => { console.error("Push reminders run failed:", e); process.exit(1); });
}
module.exports = { isDue, advance, minOfDay, GENERIC };
