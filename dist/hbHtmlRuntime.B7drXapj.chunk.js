const c="hb_higanbana_html_bridge_v1",a="/*__HB_HTML_COMPAT__*/";function d(t){const n=String(t.origin??"").trim(),e=!!t.forceBaseHref;return`
<script>${a}
(() => {
  const G = globalThis;
  const KEY = '__HB_HTML_COMPAT_RUNTIME__';
  if (G[KEY]) return;
  G[KEY] = { v: 1 };

  const CHANNEL = ${JSON.stringify(c)};
  const FORCE_BASE = ${e?"true":"false"};
  const INJECTED_ORIGIN = ${JSON.stringify(n)};

  // 推导 SillyTavern origin（用于 blob/sandbox 场景的绝对 URL 构造）
  const deriveOrigin = () => {
    if (INJECTED_ORIGIN) return INJECTED_ORIGIN;
    try {
      // new URL('blob:https://x/uuid').origin === 'https://x'
      return new URL(String(location.href)).origin || '';
    } catch {
      return '';
    }
  };
  const ST_ORIGIN = deriveOrigin();

  // ---- 修复 base href（仅 blob / 需要时） ----
  if (FORCE_BASE && ST_ORIGIN) {
    try {
      const baseEl = document.querySelector('base[href]');
      if (baseEl) {
        const rawHref = String(baseEl.getAttribute('href') || '').trim();
        const resolved = String(baseEl.href || '');
        // 常见 SPA：<base href="/"> 在 blob: 基址下会把 /xxx 解析到 blob:，这里强制修正回酒馆 origin
        const shouldFix = rawHref === '/' || resolved.startsWith('blob:') || resolved === 'null';
        if (shouldFix) baseEl.href = ST_ORIGIN + '/';
      } else {
        const base = document.createElement('base');
        base.href = ST_ORIGIN + '/';
        const head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
        head.insertBefore(base, head.firstChild);
      }
    } catch {
      // ignore
    }
  }

  // ---- 轻量 RPC（用于 ST_API 代理 / CSRF 兜底） ----
  const ctxId = (() => {
    try {
      return 'hb_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
    } catch {
      return 'hb_' + Date.now();
    }
  })();
  let seq = 0;
  const pending = new Map();

  const canPostToParent = (() => {
    try {
      return !!(window.parent && window.parent !== window && window.parent.postMessage);
    } catch {
      return false;
    }
  })();
  const canPostToOpener = (() => {
    try {
      return !!(window.opener && window.opener.postMessage);
    } catch {
      return false;
    }
  })();

  let bc = null;
  try {
    if ('BroadcastChannel' in G) bc = new BroadcastChannel(CHANNEL);
  } catch {
    bc = null;
  }

  const send = (msg) => {
    try { bc && bc.postMessage(msg); } catch {}
    try { if (canPostToParent) window.parent.postMessage(msg, '*'); } catch {}
    try { if (canPostToOpener) window.opener.postMessage(msg, '*'); } catch {}
  };

  const onData = (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.__hb !== 'higanbana' || data.v !== 1 || data.kind !== 'res') return;
    const id = String(data.id || '');
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (data.ok) p.resolve(data.data);
    else p.reject(new Error(String(data.error || 'HB bridge error')));
  };

  try { bc && (bc.onmessage = (ev) => onData(ev.data)); } catch {}
  try { window.addEventListener('message', (ev) => onData(ev.data)); } catch {}

  const rpc = (op, payload, timeoutMs = 120000) => {
    if (!bc && !canPostToParent && !canPostToOpener) {
      return Promise.reject(new Error('HB bridge unavailable'));
    }
    const id = ctxId + ':' + String(++seq);
    const msg = { __hb: 'higanbana', v: 1, kind: 'req', id, op, payload };
    send(msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('HB bridge timeout: ' + op));
      }, Math.max(1000, Number(timeoutMs || 0)));
      pending.set(id, {
        resolve: (x) => { clearTimeout(timer); resolve(x); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  };

  // ---- CSRF token：优先 RPC（主页面可直接读 token），失败则走 /csrf-token ----
  const rawFetch = typeof G.fetch === 'function' ? G.fetch.bind(G) : null;
  let csrfToken = '';
  let csrfPromise = null;

  const extractTokenFromHeadersObj = (obj) => {
    try {
      if (!obj || typeof obj !== 'object') return '';
      for (const k of Object.keys(obj)) {
        if (String(k).toLowerCase() === 'x-csrf-token') {
          const v = obj[k];
          return typeof v === 'string' ? v : String(v || '');
        }
      }
      return '';
    } catch {
      return '';
    }
  };

  const fetchCsrfToken = async () => {
    if (!rawFetch || !ST_ORIGIN) return '';
    const resp = await rawFetch(ST_ORIGIN + '/csrf-token', { method: 'GET', credentials: 'include' });
    if (!resp.ok) return '';
    const data = await resp.json().catch(() => null);
    const t = data && typeof data === 'object' ? String(data.token || '') : '';
    return t;
  };

  const getCsrfToken = async () => {
    if (csrfToken) return csrfToken;
    if (csrfPromise) return csrfPromise;
    csrfPromise = (async () => {
      // 1) 试图从主页面直接拿（最稳）
      try {
        const fromBridge = await rpc('getCsrfToken', {}, 8000);
        const t1 = typeof fromBridge === 'string' ? fromBridge : '';
        if (t1) {
          csrfToken = t1;
          return csrfToken;
        }
      } catch {
        // ignore
      }

      // 2) 本页若恰好有 SillyTavern 上下文，也可直接读
      try {
        const ctx = G.SillyTavern && typeof G.SillyTavern.getContext === 'function' ? G.SillyTavern.getContext() : null;
        const h = ctx && typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : null;
        const t2 = extractTokenFromHeadersObj(h);
        if (t2) {
          csrfToken = t2;
          return csrfToken;
        }
      } catch {
        // ignore
      }

      // 3) 最后 fallback：/csrf-token
      try {
        const t3 = await fetchCsrfToken();
        if (t3) csrfToken = t3;
      } catch {
        // ignore
      }
      return csrfToken;
    })();
    return csrfPromise;
  };

  // ---- fetch 自动注入 X-CSRF-Token + blob 场景的绝对 URL 修复 ----
  if (rawFetch) {
    G.fetch = async (input, init) => {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const urlStr = isReq ? String(input.url || '') : String(input || '');

      // 仅修复 root-relative（/xxx）在 blob: 基址下被解析到 blob: scheme 的问题。
      // 注意：不能把普通相对路径（assets/x.json）强行改写到站点根目录，否则会破坏 WebZip/VFS 内部资源 fetch。
      let finalUrl = urlStr;
      if (ST_ORIGIN && urlStr.startsWith('/') && !urlStr.startsWith('//')) {
        finalUrl = ST_ORIGIN + urlStr;
      }

      // 合并 headers（Request + init.headers）
      const headers = new Headers();
      try {
        if (isReq) input.headers.forEach((v, k) => headers.set(k, v));
      } catch {
        // ignore
      }
      try {
        if (init && init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
      } catch {
        // ignore
      }

      // 注入 X-CSRF-Token（同源请求，且未显式设置时）
      const method = String((init && init.method) || (isReq ? input.method : 'GET') || 'GET').toUpperCase();
      const hasToken = headers.has('X-CSRF-Token') || headers.has('x-csrf-token');
      // 仅对“同源请求”注入 CSRF，避免把 token 泄露到外部域名
      let isSameOrigin = false;
      if (ST_ORIGIN) {
        const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl);
        if (!abs) {
          isSameOrigin = true;
        } else {
          try {
            isSameOrigin = new URL(finalUrl).origin === ST_ORIGIN;
          } catch {
            isSameOrigin = false;
          }
        }
      }
      // 酒馆前端会给几乎所有请求带 X-CSRF-Token，这里也保持一致（同源 + 未显式设置时才注入）
      if (isSameOrigin && !hasToken) {
        try {
          const t = await getCsrfToken();
          if (t) headers.set('X-CSRF-Token', t);
        } catch {
          // ignore
        }
      }

      const outInit = Object.assign({}, init || {});
      outInit.headers = headers;
      // 仅在同源时强制带 cookie/session；跨域请求保持默认（避免触发 CORS credentials 限制）
      if (init && init.credentials) {
        outInit.credentials = init.credentials;
      } else if (isReq && input.credentials) {
        outInit.credentials = input.credentials;
      } else if (isSameOrigin) {
        outInit.credentials = 'include';
      }

      // 若 input 是 Request，使用 new Request(input, outInit) 克隆并覆盖（避免丢 body/method）
      if (isReq) return rawFetch(new Request(input, outInit));
      return rawFetch(finalUrl, outInit);
    };
  }

  // ---- XHR 自动注入 X-CSRF-Token（给 jQuery/axios 等） ----
  try {
    const XHR = G.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__hbPatched) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      const origSet = XHR.prototype.setRequestHeader;

      XHR.prototype.__hbPatched = true;

      XHR.prototype.open = function(method, url, async, user, password) {
        try {
          this.__hbMethod = String(method || 'GET').toUpperCase();
          this.__hbAsync = async !== false;
          this.__hbHeadersSet = new Set();
        } catch {}

        let final = String(url || '');
        if (ST_ORIGIN && final.startsWith('/') && !final.startsWith('//')) {
          final = ST_ORIGIN + final;
        }
        try {
          this.__hbFinalUrl = final;
        } catch {}
        return origOpen.call(this, method, final, async, user, password);
      };

      XHR.prototype.setRequestHeader = function(name, value) {
        try {
          if (this.__hbHeadersSet) this.__hbHeadersSet.add(String(name || '').toLowerCase());
        } catch {}
        return origSet.call(this, name, value);
      };

      XHR.prototype.send = function(body) {
        const method = String(this.__hbMethod || 'GET').toUpperCase();
        const headersSet = this.__hbHeadersSet;
        const hasToken = headersSet && (headersSet.has('x-csrf-token') || headersSet.has('x-csrf-token'.toLowerCase()));
        const urlNow = String(this.__hbFinalUrl || '');

        // 只对“同源请求”注入 token / credentials
        let isSameOrigin = false;
        if (ST_ORIGIN) {
          const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlNow);
          if (!abs) {
            isSameOrigin = true;
          } else {
            try {
              isSameOrigin = new URL(urlNow).origin === ST_ORIGIN;
            } catch {
              isSameOrigin = false;
            }
          }
        }

        // 尽量保证 cookie/session 能带上（尤其 blob/sandbox 场景）
        try {
          if (isSameOrigin) this.withCredentials = true;
        } catch {}

        // 同步 XHR：只能 best-effort（有 token 就加，没有就算）
        if (!this.__hbAsync) {
          try {
            if (isSameOrigin && !hasToken && csrfToken) {
              origSet.call(this, 'X-CSRF-Token', csrfToken);
            }
          } catch {}
          return origSend.call(this, body);
        }

        // 异步 XHR：延迟 send，等 token
        if (isSameOrigin && !hasToken) {
          getCsrfToken()
            .then(t => {
              try {
                if (t && this.__hbHeadersSet && !this.__hbHeadersSet.has('x-csrf-token')) {
                  origSet.call(this, 'X-CSRF-Token', t);
                }
              } catch {}
              origSend.call(this, body);
            })
            .catch(() => {
              origSend.call(this, body);
            });
          return;
        }

        return origSend.call(this, body);
      };
    }
  } catch {
    // ignore
  }

  // ---- 提供最小 SillyTavern 上下文（让 st-api-wrapper / 其它脚本能拿到 getRequestHeaders） ----
  try {
    if (!G.SillyTavern) G.SillyTavern = {};
    if (typeof G.SillyTavern.getContext !== 'function') {
      G.SillyTavern.getContext = () => ({
        getRequestHeaders: () => {
          const h = { 'Content-Type': 'application/json' };
          if (csrfToken) h['X-CSRF-Token'] = csrfToken;
          return h;
        },
      });
    }
  } catch {
    // ignore
  }

  // ---- 提供 ST_API 代理（没有 ST_API 时通过桥接调用主页面 ST_API） ----
  try {
    if (!G.ST_API) {
      const call = async (endpoint, params) => {
        return await rpc('callSTAPI', { endpoint, params: params || {} }, 120000);
      };
      G.ST_API = new Proxy({}, {
        get(_t, ns) {
          return new Proxy({}, {
            get(_t2, method) {
              return (params) => call(String(ns) + '.' + String(method), params || {});
            },
          });
        },
      });
    }
  } catch {
    // ignore
  }

  // ---- 跨域/无法测高时：向父页面上报 iframe 高度（父页面需监听 HB_IFRAME_HEIGHT） ----
  try {
    const TYPE = 'HB_IFRAME_HEIGHT';
    const iframeName = String(window.name || '');
    if (iframeName) {
      let last = 0;
      const compute = () => {
        const body = document.body;
        const doc = document.documentElement;
        const h1 = body ? body.scrollHeight : 0;
        const h2 = doc ? doc.scrollHeight : 0;
        const h3 = body ? body.offsetHeight : 0;
        const h4 = doc ? doc.offsetHeight : 0;
        return Math.max(h1, h2, h3, h4);
      };
      const post = () => {
        const h = compute();
        if (!Number.isFinite(h) || h <= 0) return;
        if (Math.abs(h - last) < 1) return;
        last = h;
        try { window.parent && window.parent.postMessage({ type: TYPE, iframeName, height: h }, '*'); } catch {}
      };
      if ('ResizeObserver' in G) {
        try {
          const ro = new ResizeObserver(() => post());
          ro.observe(document.documentElement);
          if (document.body) ro.observe(document.body);
        } catch {}
      }
      window.addEventListener('load', () => { post(); setTimeout(post, 100); });
      setTimeout(post, 0);
    }
  } catch {
    // ignore
  }
})();
<\/script>
`}function h(t,n={}){const e=String(t??"");if(!e.trim()||e.includes(a))return e;const r=d(n),s=/<head\\b[^>]*>/i;if(s.test(e))return e.replace(s,o=>o+r);const i=/<html\\b[^>]*>/i;return i.test(e)?e.replace(i,o=>o+`<head>${r}</head>`):r+e}export{c as H,h as i};
