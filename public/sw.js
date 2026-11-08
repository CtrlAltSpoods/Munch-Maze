/* Munch Maze service worker: lets the game be installed as an app, and shows the last
   version of the page if the server can't be reached. Always tries the network first,
   so a new version of the game is picked up straight away. The game itself still needs
   the server: nothing here works offline beyond the title screen. */
'use strict';
const CACHE = 'munch-maze-v1';
const SHELL = ['./', 'index.html', 'style.css', 'maze.js', 'audio.js', 'fx.js', 'nuke.js', 'logo.js', 'space.js', 'models.js', 'client.js', 'icon.png', 'icon-192.png', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  // only this site's own files; never the API, logins, the admin page or custom sounds
  if (r.method !== 'GET' || u.origin !== location.origin || /\/(api|auth|custom|ws)(\/|$)|admin|healthz/.test(u.pathname)) return;
  e.respondWith(fetch(r).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('./'))));
});
