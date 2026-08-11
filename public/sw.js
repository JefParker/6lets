// Bump on every asset change — `install` only re-fetches ASSETS when this
// changes, and cacheFirst matches with ignoreSearch, so the `?v=` query strings
// in index.html do not bust the cache on their own.
const CACHE_NAME = '6lets-cache-v49';
// Word data, refreshed by periodic background sync — NOT versioned with the
// assets above, and exempt from the activate-time cleanup, because wiping it
// on every asset deploy would throw away exactly the offline coverage it
// exists to provide. The page merges this into localStorage on load (see
// fetchOfflineWords in script.js).
const WORDS_CACHE = 'sixlets-words-v1';
const WORDS_URL = '/api/words';
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
                    if (cacheName !== CACHE_NAME && cacheName !== WORDS_CACHE) {
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

// Periodic background sync (registered by the page; Chromium-only, installed
// PWAs). Tops up the word cache roughly daily even when nobody opens the app,
// so a device that goes offline still has current words. On browsers without
// the API this handler simply never fires and page-load fetches do the work.
async function refreshWords() {
    try {
        const response = await fetch(WORDS_URL);
        if (!response.ok) return;

        const clone = response.clone();
        const data = await response.json();
        // Same rule as the page: never let a degraded response clobber a good
        // cache.
        if (!Array.isArray(data) || data.length === 0) return;

        const cache = await caches.open(WORDS_CACHE);
        await cache.put(WORDS_URL, clone);
    } catch (e) {
        // Offline or transient failure — the next sync or page load retries.
    }
}

self.addEventListener('periodicsync', event => {
    if (event.tag === 'refresh-words') {
        event.waitUntil(refreshWords());
    }
});

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
