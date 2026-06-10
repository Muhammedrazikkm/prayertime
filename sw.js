// Simple service worker with TTL-based stale-while-revalidate caching
const CACHE_NAME = 'prayer-static-v1';

const TTL = {
  navigation: 5 * 60 * 1000, // 5 minutes for HTML
  script: 24 * 60 * 60 * 1000, // 24 hours for JS
  style: 24 * 60 * 60 * 1000, // 24 hours for CSS
  image: 7 * 24 * 60 * 60 * 1000, // 7 days for images/icons
  default: 24 * 60 * 60 * 1000
};

function getTTLForRequest(req){
  const dest = req.destination || '';
  if(dest === 'document' || req.mode === 'navigate') return TTL.navigation;
  if(dest === 'script') return TTL.script;
  if(dest === 'style') return TTL.style;
  if(dest === 'image' || dest === 'icon') return TTL.image;
  return TTL.default;
}

async function cachePutWithTimestamp(cacheName, request, response){
  try{
    const cache = await caches.open(cacheName);
    const cloned = response.clone();
    const buffer = await cloned.arrayBuffer();
    const newHeaders = new Headers(cloned.headers || {});
    newHeaders.set('sw-fetched-time', String(Date.now()));
    const newResp = new Response(buffer, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers: newHeaders
    });
    await cache.put(request, newResp);
  }catch(e){
    // ignore cache failures
  }
}

async function fetchAndCache(request){
  try{
    const res = await fetch(request);
    if(res && res.ok){
      await cachePutWithTimestamp(CACHE_NAME, request, res);
    }
    return res;
  }catch(e){
    return null;
  }
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try{
      const req = new Request('index.html');
      const res = await fetch(req);
      if(res && res.ok) await cachePutWithTimestamp(CACHE_NAME, req, res);
    }catch(e){}
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => { if(k !== CACHE_NAME) return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const accept = req.headers.get('Accept') || '';
  // Navigation requests: network-first, fallback to cache
  if(accept.includes('text/html')){
    event.respondWith((async () => {
      try{
        const net = await fetch(req);
        if(net && net.ok){
          cachePutWithTimestamp(CACHE_NAME, req, net.clone());
          return net;
        }
      }catch(e){}
      const cached = await caches.match(req);
      return cached || fetch(req).catch(()=>new Response('Offline', { status: 503 }));
    })());
    return;
  }

  // Other assets: cache-first with TTL (stale-while-revalidate)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const ttl = getTTLForRequest(req);
    if(cached){
      const fetchedTime = Number(cached.headers.get('sw-fetched-time') || '0');
      const age = Date.now() - fetchedTime;
      // If stale, update in background
      if(age > ttl){
        event.waitUntil(fetchAndCache(req));
      }
      return cached;
    }
    const netRes = await fetchAndCache(req);
    return netRes || (await caches.match(req)) || new Response(null, { status: 504 });
  })());
});
