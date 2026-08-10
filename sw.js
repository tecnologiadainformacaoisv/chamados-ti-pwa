const APP_VERSION = '0.3.5';
const CACHE_NAME = `chamados-ti-${APP_VERSION}`;
const ASSETS = [
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './assets/icon.svg',
  './assets/icon-maskable.svg',
  './assets/logo-isv.svg',
  './assets/favicon-isv.png'
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
      icon:     './assets/icon.svg',
      badge:    './assets/icon.svg',
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
  // Nunca passar chamada de API (ClickUp direto ou via proxy do Worker) nem
  // requisição não-GET pelo caches.match() — corpo de POST só pode ser lido
  // uma vez, e fetch(e.request) de novo depois de um cache-miss quebra com
  // "Failed to fetch" sem nunca chegar no Worker (bug real, 2026-08-10: isso
  // travava "Abrir Chamado" porque a checagem antiga só cobria api.clickup.com,
  // domínio que o app não chama mais direto — hoje é sempre via workers.dev).
  const isApiCall = e.request.url.includes('api.clickup.com') || e.request.url.includes('workers.dev');
  if (isApiCall || e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
