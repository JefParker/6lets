const CACHE_NAME = '6lets-cache-v37';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/dictionary.js',
    '/manifest.json'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});
self.addEventListener('fetch', event => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;
    
    // Only intercept requests for our own origin (ignore analytics, external scripts)
    if (!event.request.url.startsWith(self.location.origin)) return;
    
    // Don't cache API calls (offline words handled by localStorage)
    if (event.request.url.includes('/api/')) return;

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request).then(response => {
                // Optionally cache new assets here
                return response;
            }).catch(error => {
                console.warn('Fetch failed for', event.request.url, error);
                // Must return a Response object to event.respondWith
                return Response.error();
            });
        })
    );
});
