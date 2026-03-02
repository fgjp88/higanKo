import{i as w}from"./hbHtmlRuntime.CcNoB2Zg.chunk.js";const s=self,y="st-higanbana-vfs-";function x(){return new URL("vfs/",s.registration.scope).pathname}function v(n){const t=x(),a=n.pathname;if(!a.startsWith(t))return null;const i=a.slice(t.length),c=i.indexOf("/");if(c<=0)return null;const o=decodeURIComponent(i.slice(0,c)),e=i.slice(c+1);return!o||!e?null:{projectId:o,innerPath:e,vfsBasePath:t}}s.addEventListener("install",n=>{n.waitUntil(s.skipWaiting())});s.addEventListener("activate",n=>{n.waitUntil(s.clients.claim())});s.addEventListener("message",n=>{n.data?.type==="HB_SKIP_WAITING"&&s.skipWaiting()});s.addEventListener("fetch",n=>{const t=n.request;if(t.method!=="GET")return;const a=new URL(t.url),i=v(a);if(!i)return;const c=`${y}${i.projectId}`;n.respondWith((async()=>{const e=await(await caches.open(c)).match(t);if(e)try{const l=String(e.headers.get("content-type")||"").toLowerCase(),h=String(t.headers.get("accept")||"").toLowerCase(),p=t.destination,u=t.mode==="navigate"||p==="document",m=l.includes("text/html")||h.includes("text/html");if(!u||!m)return e;const f=await e.clone().text(),g=w(f,{origin:a.origin,forceBaseHref:!1}),r=new Headers(e.headers);return r.get("content-type")||r.set("content-type","text/html; charset=utf-8"),new Response(g,{status:e.status,statusText:e.statusText,headers:r})}catch{return e}const d=t.headers.get("accept")||"";return t.mode==="navigate"||d.includes("text/html")?new Response(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>피안화 VFS 404</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.4;margin:20px}
  code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:6px}
</style>
<h2>리소스를 찾을 수 없습니다 (VFS)</h2>
<p>요청한 파일이 캐시에 없습니다: <code>${a.pathname}</code></p>
<p>SillyTavern 페이지로 돌아가서 해당 캐릭터의 WebZip을 다시 가져오거나 허용하십시오. 또는 진입 페이지의 리소스 경로가 올바른지 확인하십시오(상대 경로 사용 권장).</p>`,{status:404,headers:{"Content-Type":"text/html; charset=utf-8"}}):new Response("Not Found",{status:404,headers:{"Content-Type":"text/plain; charset=utf-8"}})})())});
