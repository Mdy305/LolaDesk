/**
 * sw.js — makes LolaDesk installable on a phone's home screen.
 * Network only, on purpose: it caches nothing, so a deploy is never served
 * stale and nobody gets stuck on an old copy of the app. If a request fails,
 * the browser handles it exactly as it would without a service worker.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only: let the browser do the request */ });
