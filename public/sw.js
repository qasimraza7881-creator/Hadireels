/* Hadi Reels service worker: caches the app shell so it opens fast and works as an installed app. Videos and Firebase calls are never cached. */
const C='hadireels-v2',SHELL=['/','/manifest.json','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match('/'))));
});

/* push notifications (sent by the push_event and push_msg functions) */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(_){}
  const x=d.data||d.notification||d,title=x.title||'Hadi Reels',body=x.body||'';
  e.waitUntil(self.registration.showNotification(title,{body,icon:'/icon-192.png',badge:'/icon-192.png',data:{url:x.url||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus'in c)return c.focus()}return self.clients.openWindow((e.notification.data&&e.notification.data.url)||'/')}));
});
