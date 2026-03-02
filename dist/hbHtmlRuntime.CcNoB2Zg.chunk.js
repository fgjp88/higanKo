const s="/*__HB_HTML_COMPAT__*/";function c(t){const r=String(t.origin??"").trim(),e=!!t.forceBaseHref;return`
<script>${s}
(() => {
  const G = globalThis;
  const KEY = '__HB_HTML_COMPAT_RUNTIME__';
  if (G[KEY]) return;
  G[KEY] = { v: 1 };

  const FORCE_BASE = ${e?"true":"false"};
  const INJECTED_ORIGIN = ${JSON.stringify(r)};

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

  // ---- 插件内桥接通道（BroadcastChannel RPC） ----
  const HB_RPC_CHANNEL = 'hb_higanbana_rpc_v1';
  const HB_RPC_REQ = 'HB_BRIDGE_RPC_REQ';
  const HB_RPC_RES = 'HB_BRIDGE_RPC_RES';
  const HB_RPC_CLIENT_ID = 'hb-client-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  const HB_RPC_TIMEOUT_MS = 10000;
  let hbRpcSeq = 0;
  const hbRpcPending = new Map();
  let hbRpcChannel = null;
  let hbRpcUnavailable = false;

  const ensureRpcChannel = () => {
    if (hbRpcUnavailable) return null;
    if (hbRpcChannel) return hbRpcChannel;
    try {
      const ch = new BroadcastChannel(HB_RPC_CHANNEL);
      ch.addEventListener('message', ev => {
        const data = ev && ev.data;
        if (!data || data.type !== HB_RPC_RES) return;
        if (String(data.clientId || '') !== HB_RPC_CLIENT_ID) return;
        const id = String(data.id || '');
        const pending = hbRpcPending.get(id);
        if (!pending) return;
        hbRpcPending.delete(id);
        clearTimeout(pending.timer);

        if (data.ok) {
          pending.resolve(decodeRpcResult(data.result));
        } else {
          pending.reject(new Error(String(data.error || 'RPC 호출 실패')));
        }
      });
      hbRpcChannel = ch;
      return ch;
    } catch {
      hbRpcUnavailable = true;
      return null;
    }
  };

  const sanitizeRpcValue = (value, seen) => {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return value;
    if (t === 'function') return { __hb_rpc_unserializable__: 'function' };
    if (t === 'symbol') return String(value);

    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
    if (typeof Date !== 'undefined' && value instanceof Date) return new Date(value.getTime());
    if (typeof RegExp !== 'undefined' && value instanceof RegExp) return new RegExp(value.source, value.flags);

    if (typeof Window !== 'undefined' && value instanceof Window) return { __hb_rpc_unserializable__: 'window' };
    if (typeof Document !== 'undefined' && value instanceof Document) return { __hb_rpc_unserializable__: 'document' };
    if (typeof Element !== 'undefined' && value instanceof Element) {
      return { __hb_rpc_unserializable__: 'element', tag: String(value.tagName || '').toLowerCase() };
    }

    if (!seen) seen = new WeakMap();
    if (seen.has(value)) return { __hb_rpc_cycle__: true };
    seen.set(value, true);

    if (Array.isArray(value)) {
      return value.map(v => sanitizeRpcValue(v, seen));
    }

    const out = {};
    try {
      for (const k of Object.keys(value)) {
        out[k] = sanitizeRpcValue(value[k], seen);
      }
      return out;
    } catch {
      return { __hb_rpc_unserializable__: 'object' };
    }
  };

  const sanitizeRpcArgs = args => {
    if (!Array.isArray(args)) return [];
    return args.map(v => sanitizeRpcValue(v, new WeakMap()));
  };

  const callBridgeRpc = (root, path, args) => {
    const ch = ensureRpcChannel();
    if (!ch) {
      return Promise.reject(new Error('RPC 브리지 채널을 사용할 수 없음'));
    }

    const id = HB_RPC_CLIENT_ID + ':' + String(++hbRpcSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hbRpcPending.delete(id);
        reject(new Error('RPC 호출 시간 초과'));
      }, HB_RPC_TIMEOUT_MS);

      hbRpcPending.set(id, { resolve, reject, timer });
      try {
        ch.postMessage({
          type: HB_RPC_REQ,
          id,
          clientId: HB_RPC_CLIENT_ID,
          root,
          path: Array.isArray(path) ? path : [],
          callerPath: String(location && location.pathname ? location.pathname : ''),
          callerHref: String(location && location.href ? location.href : ''),
          args: sanitizeRpcArgs(args),
        });
      } catch (err) {
        hbRpcPending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  };

  const decodeRpcResult = result => {
    try {
      if (!result || typeof result !== 'object') return result;
      if ((result.__hb_rpc_function__ === true || result.__hb_rpc_object__ === true) && result.root) {
        const root = String(result.root || '').trim();
        const path = Array.isArray(result.path) ? result.path.map(x => String(x)) : [];
        if (root) return createBridgeProxy(root, path);
      }
      return result;
    } catch {
      return result;
    }
  };

  const createBridgeProxy = (root, path = []) => {
    const fn = function () {};
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toStringTag) return 'HBBridgeProxy';
        if (prop === '__hbBridgeRoot') return root;
        if (prop === '__hbBridgePath') return path.slice();
        if (prop === '__hbBridgeGet') return () => callBridgeRpc(root, path, []);
        if (prop === 'toJSON') return () => '[HBBridgeProxy ' + root + '.' + path.join('.') + ']';
        if (prop === 'toString') return () => '[HBBridgeProxy ' + root + '.' + path.join('.') + ']';
        if (prop === 'valueOf') return () => ({ __hbBridgeRoot: root, __hbBridgePath: path.slice() });
        if (typeof prop === 'symbol') return undefined;
        return createBridgeProxy(root, path.concat(String(prop)));
      },
      apply(_t, _thisArg, args) {
        return callBridgeRpc(root, path, args);
      },
    });
  };

  const shouldSkipBridgeGlobalKey = key => {
    const k = String(key || '').trim();
    if (!k) return true;
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') return true;
    if (/^__VUE/.test(k)) return true;
    if (/^__REACT/.test(k)) return true;
    if (k === 'foxAgentCrossRequestVersion') return true;
    return false;
  };

  const defineBridgeGlobalGetter = key => {
    const k = String(key || '').trim();
    if (!k) return;
    if (shouldSkipBridgeGlobalKey(k)) return;
    if (k in G) return;

    try {
      Object.defineProperty(G, k, {
        configurable: true,
        enumerable: false,
        get() {
          return createBridgeProxy('__HB_GLOBAL__', [k]);
        },
        set(v) {
          try {
            Object.defineProperty(G, k, {
              value: v,
              writable: true,
              configurable: true,
              enumerable: false,
            });
          } catch {
            // ignore
          }
        },
      });
    } catch {
      // ignore
    }
  };

  const installCoreBridgeGlobals = () => {
    defineBridgeGlobalGetter('ST_API');
    defineBridgeGlobalGetter('Higanbana');
    defineBridgeGlobalGetter('higanbana');
  };

  const installBridgeGlobals = async () => {
    // 先同步装核心入口，避免首帧访问 undefined。
    installCoreBridgeGlobals();

    try {
      const keys = await callBridgeRpc('__HB_INTERNAL__', ['listGlobals'], []);
      const rootProxy = createBridgeProxy('__HB_GLOBAL__');
      G.__HB_TOP__ = rootProxy;

      if (!Array.isArray(keys)) return;

      for (const keyRaw of keys) {
        defineBridgeGlobalGetter(keyRaw);
      }
    } catch {
      // ignore
    }
  };

  // ---- CSRF token：优先本页上下文获取，失败则走 /csrf-token ----
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
      // 1) 本页上下文
      try {
        const ctx = G.SillyTavern && typeof G.SillyTavern.getContext === 'function' ? G.SillyTavern.getContext() : null;
        const h = ctx && typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : null;
        const t2 = extractTokenFromHeadersObj(h);
        if (t2) {
          csrfToken = t2;
          return t2;
        }
      } catch {
        // ignore
      }

      // 2) fallback：/csrf-token
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
      // 注意：不能把普通相对路径（assets/x.json）强行改写到站点根目录，아니요则会破坏 WebZip/VFS 内部资源 fetch。
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

  // ---- 透传主页面 API（通过插件内桥接 RPC，而非 opener 直连） ----
  try {
    // 先为 SillyTavern 保留最小上下文兜底，同时附加桥接代理入口。
    if (!G.SillyTavern || typeof G.SillyTavern !== 'object') {
      G.SillyTavern = {};
    }
    if (!G.SillyTavern.__hbBridgeProxy) {
      G.SillyTavern.__hbBridgeProxy = createBridgeProxy('SillyTavern');
    }

    // 安装桥接全局（核心入口同步，其余全局异步按需透传）。
    // 读取非函数值时可使用 window.xxx.__hbBridgeGet()
    void installBridgeGlobals();
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
`}function l(t,r={}){const e=String(t??"");if(!e.trim()||e.includes(s))return e;const n=c(r),o=/<head\\b[^>]*>/i;if(o.test(e))return e.replace(o,i=>i+n);const a=/<html\\b[^>]*>/i;return a.test(e)?e.replace(a,i=>i+`<head>${n}</head>`):n+e}export{l as i};
