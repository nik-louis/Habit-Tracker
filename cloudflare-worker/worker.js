// Second, independent trigger for the exact same push-reminder job that
// .github/scripts/send-push-reminders.js already performs on a GitHub Actions schedule. GitHub does
// NOT guarantee scheduled-workflow timing on free/public repos — under platform load, `schedule` runs
// are silently skipped rather than queued, which is why reminders were arriving hours late. Cloudflare
// Workers Cron Triggers run on Cloudflare's own scheduler and don't share that failure mode, so this
// Worker runs alongside GitHub Actions (not instead of it) as cheap redundancy: whichever of the two
// fires first sends the reminder, and the shared `lastFired` bookkeeping in Firebase means the other
// one sees it's already done and skips — no duplicate notifications, no coordination needed between them.
//
// Node's `web-push` library (used by the GitHub Actions version) depends on Node-only crypto APIs that
// don't exist in the Workers runtime. This file re-implements the same reminder-matching logic against
// the same Firebase REST endpoints, but sends pushes via @pushforge/builder, which builds the VAPID
// JWT and encrypts the payload using the standard Web Crypto API instead — see rawVapidKeysToJWK()
// below for how it reuses the exact same VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY secrets already in use,
// with no new keys and no client-side resubscription required.
import { buildPushHTTPRequest } from "@pushforge/builder";

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

// Kept byte-for-byte identical to isDue()/advance() in .github/scripts/send-push-reminders.js on
// purpose — if the reminder types or matching rules ever change, update both copies together.
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

function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// web-push's generateVAPIDKeys() (used to create the existing VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY
// secrets) stores the key pair as raw base64url EC bytes: a 65-byte uncompressed point (0x04 + 32-byte
// X + 32-byte Y) for the public key, and a raw 32-byte scalar for the private key. @pushforge/builder
// wants the private key as a JWK. This is a pure reformat of that SAME key pair — slicing bytes, not
// deriving new ones — so the result signs pushes the exact same way web-push would have.
function rawVapidKeysToJWK(publicKeyB64Url, privateKeyB64Url) {
  const pub = b64urlToBytes(publicKeyB64Url);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point");
  const x = pub.slice(1, 33), y = pub.slice(33, 65);
  return { kty: "EC", crv: "P-256", x: bytesToB64url(x), y: bytesToB64url(y), d: privateKeyB64Url };
}

async function run(env) {
  const DB_URL = (env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
  const SYNC_CODE = env.FIREBASE_SYNC_CODE || "";
  const VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY || "";
  const VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY || "";
  const VAPID_SUBJECT = env.VAPID_SUBJECT || "mailto:push@example.com";

  if (!DB_URL || !SYNC_CODE || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log("Push reminders (Cloudflare): required secrets not configured — skipping.");
    return;
  }

  const privateJWK = rawVapidKeysToJWK(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const pushPath = `${DB_URL}/sync/${SYNC_CODE}/push.json`;
  const res = await fetch(pushPath);
  if (!res.ok) { console.log("Push reminders (Cloudflare): could not read /push node, status", res.status); return; }
  const devices = await res.json();
  if (!devices || typeof devices !== "object") { console.log("Push reminders (Cloudflare): no registered devices."); return; }

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
        const { endpoint, headers, body } = await buildPushHTTPRequest({
          privateJWK,
          subscription: rec.sub,
          message: { payload: { title: generic.title, body: generic.body, tag: r.id }, adminContact: VAPID_SUBJECT },
        });
        const pushRes = await fetch(endpoint, { method: "POST", headers, body });
        if (pushRes.status === 404 || pushRes.status === 410) {
          // Subscription is dead (uninstalled / expired) — drop the whole device record and move on.
          await fetch(`${DB_URL}/sync/${SYNC_CODE}/push/${deviceId}.json`, { method: "DELETE" }).catch(() => {});
          deviceGone = true;
          break;
        }
        if (pushRes.ok || pushRes.status === 201) sent++;
        else console.log(`Push reminders (Cloudflare): push failed for device ${deviceId}, reminder ${r.id}, status ${pushRes.status}`);
      } catch (e) {
        console.log(`Push reminders (Cloudflare): error for device ${deviceId}, reminder ${r.id}:`, e.message);
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

  console.log(`Push reminders (Cloudflare): checked ${Object.keys(devices).length} device(s), sent ${sent} notification(s).`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // Manual trigger for testing — visiting the Worker's own *.workers.dev URL runs the same check the
  // cron does, mirroring the GitHub Actions "Run workflow" button. Safe to expose unauthenticated:
  // worst case it sends an already-due reminder a little early, same as the cron firing early would.
  async fetch(request, env) {
    await run(env);
    return new Response("ok");
  },
};
