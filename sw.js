const APP_VERSION = '0.1.17';
const CACHE_NAME = `chamados-ti-${APP_VERSION}`;
const ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
  './logo-isv.svg'
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

// Push notification received
self.addEventListener('push', e => {
  const payload = e.data?.json() ?? { title: 'Chamados de TI – ISV', body: 'Atualização recebida' };
  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body:     payload.body,
      icon:     './icon.svg',
      badge:    './icon.svg',
      tag:      `task-${payload.data?.task_id ?? 'update'}`,
      renotify: true,
      data:     payload.data ?? {}
    })
  );
});

// Click on notification → abre o chamado específico
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { task_id, status } = e.notification.data ?? {};
  const tab    = status === 'encerrado' ? 'todos-chamados' : 'meus-chamados';
  const target = task_id ? `${tab}:${task_id}` : tab;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      const appClient = list.find(c => c.url.startsWith(self.registration.scope));
      if (appClient) {
        // App já aberto: manda mensagem para navegar ao chamado
        appClient.postMessage({ type: 'OPEN_TASK', tab, task_id });
        return appClient.focus();
      }
      // App fechado: abre na tab/chamado correto via hash
      return clients.openWindow(`${self.registration.scope}#${target}`);
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
