const APP_VERSION = '0.1.6';
const CACHE_NAME = `chamados-ti-${APP_VERSION}`;
const ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Push notification received (app can be closed)
self.addEventListener('push', e => {
  const data = e.data?.json() ?? { title: 'Chamados de TI – ISV', body: 'Atualização recebida' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:      data.body,
      icon:      './icon.svg',
      badge:     './icon.svg',
      tag:       'chamado-update',
      renotify:  true,
      data:      { url: self.registration.scope }
    })
  );
});

// Click on OS notification → opens/focuses the PWA
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(self.registration.scope);
    })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('api.clickup.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
