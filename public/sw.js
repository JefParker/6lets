// Bump on every asset change — `install` only re-fetches ASSETS when this
// changes, and cacheFirst matches with ignoreSearch, so the `?v=` query strings
// in index.html do not bust the cache on their own.
const CACHE_NAME = '6lets-cache-v42';
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

function isNavigation(request) {
    return request.mode === 'navigate' || request.destination === 'document';
}

async function cacheFirst(request) {
    // ignoreSearch so versioned URLs (e.g. script.js?v=40) still match the
    // precached /script.js entry — otherwise the app fails to boot offline.
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
        const response = await fetch(request);
        // Runtime-cache successful same-origin responses so navigations and
        // lazily-loaded assets are available offline next time.
        if (response && response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME)
                .then(cache => cache.put(request, clone))
                // cache.put rejects on partial (206) responses, among others.
                .catch(err => console.warn('Cache put failed for', request.url, err));
        }
        return response;
    } catch (error) {
        console.warn('Fetch failed for', request.url, error);
        // Must return a Response object to event.respondWith
        return Response.error();
    }
}

// Network-first for HTML. Cache-first on navigations meant a returning player
// kept getting stale markup — and therefore stale asset versions — until the
// service worker itself happened to update.
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME)
                .then(cache => cache.put(request, clone))
                // cache.put rejects on partial (206) responses, among others.
                .catch(err => console.warn('Cache put failed for', request.url, err));
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;

        const shell = await caches.match('/index.html');
        if (shell) return shell;

        return Response.error();
    }
}

self.addEventListener('fetch', event => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;

    // Only intercept requests for our own origin (ignore analytics, external scripts)
    if (!event.request.url.startsWith(self.location.origin)) return;

    // Don't cache API calls (offline words handled by localStorage)
    if (event.request.url.includes('/api/')) return;

    event.respondWith(
        isNavigation(event.request) ? networkFirst(event.request) : cacheFirst(event.request)
    );
});
