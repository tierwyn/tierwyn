// ponytail: push-only SW (no fetch listener — Chrome 108+ does not require one for
// PWA installability, and a pass-through fetch handler forces SW boot on every
// navigation/refresh and can hang reloads on stalled sockets).
// Add offline precache when offline Tierwyn becomes a real ask.
self.addEventListener('install',    (e) => self.skipWaiting());
self.addEventListener('activate',   (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tierwyn', {
    body: d.body || '', tag: d.tag || 'tierwyn-v1', data: d.data || {},
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const cid = e.notification.data && e.notification.data.conversationId;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      await c.focus();
      if (cid) c.postMessage({ type: 'tierwyn:navigate', conversationId: cid });
      return;
    }
    await self.clients.openWindow(cid ? `/?c=${cid}` : '/');
  })());
});
