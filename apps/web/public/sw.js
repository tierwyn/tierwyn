// ponytail: network-only SW. Exists only so Chrome Android offers "Install app".
// Add offline precache when offline Tierwyn becomes a real ask.
self.addEventListener('install',    (e) => self.skipWaiting());
self.addEventListener('activate',   (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',     (e) => e.respondWith(fetch(e.request)));

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
