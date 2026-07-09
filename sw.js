/* Service Worker — Habitunity
   Provides: offline caching of the app shell + notification display.
   Two notification sources: (1) the page's own setInterval-based reminder loop, which only
   fires while the tab is open — shown via reg.showNotification() so they still appear when
   backgrounded but not fully closed; (2) real Web Push (see the "push" listener below), sent
   by a GitHub Actions job while the app is fully closed — the OS wakes this SW directly. */

const CACHE = "habitunity-v1";
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for navigation, cache fallback (so updates are picked up, offline still works)
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});

// Real Web Push: fired by the browser itself (woken by the OS push service) even when the app is
// fully closed — unlike the page's own setInterval-based reminder loop, which only runs while the
// tab is open and foregrounded. Payload is sent by the GitHub Actions script (see
// .github/scripts/send-push-reminders.js) — deliberately generic, no personal reminder text (see
// pushRemindersProjection() in index.html for why).
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || "⏰ Habitunity";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "push",
      icon: "icon-192.png",
      badge: "icon-192.png",
      renotify: true,
      vibrate: [80, 40, 80],
    })
  );
});

// Tapping a notification focuses/opens the app
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html");
    })
  );
});
