// @gcu/accountable — page-side client · CC0-1.0 (public domain) — vendor freely.
// Drop-in helper for GCU tools that want to fetch through Accountable when available,
// with graceful fallback when not. Supports { stream: true } and { receipt: true }.
//
// Usage:
//   import { gcuFetch, hasAccountable } from './accountable-client.js';
//   const res = await gcuFetch('https://feeds.example.com/atom.xml');
//   const text = await res.text();
//
// Resolution order:
//   1. @gcu/accountable extension installed + this origin is allowed
//        → brokered fetch (no CORS).
//   2. Direct fetch() — works if the endpoint sends permissive CORS.
//   3. If window.GCU_PROXY is set, fall back to that proxy URL.

const PING_TIMEOUT = 200;
const REQUEST_TIMEOUT = 20000;

function arrayBufferFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Map a Fetch-style request body to { body, bodyEncoding } for the wire.
// Strings and URLSearchParams go through as text; ArrayBuffer / TypedArray /
// Blob get base64'd. FormData and ReadableStream are rejected with a clear
// error rather than silently mishandled.
async function serializeRequestBody(body) {
  if (body == null || body === '') return { body: null, bodyEncoding: 'text' };
  if (typeof body === 'string') return { body, bodyEncoding: 'text' };
  if (body instanceof URLSearchParams) return { body: body.toString(), bodyEncoding: 'text' };
  if (body instanceof ArrayBuffer) {
    return { body: base64FromBytes(new Uint8Array(body)), bodyEncoding: 'base64' };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: base64FromBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      bodyEncoding: 'base64'
    };
  }
  if (body instanceof Blob) {
    return { body: base64FromBytes(new Uint8Array(await body.arrayBuffer())), bodyEncoding: 'base64' };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new TypeError('gcuFetch: FormData bodies are not supported. Wrap in a Blob with an explicit content-type, or serialize yourself.');
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new TypeError('gcuFetch: streaming request bodies are not supported.');
  }
  throw new TypeError('gcuFetch: unsupported body type: ' + (body?.constructor?.name ?? typeof body));
}

let accDetection = null;   // cached POSITIVE detection (a marker/version promise)
let lastNegativeAt = 0;       // when the last ping resolved false (for the re-detect cooldown)
const NEGATIVE_COOLDOWN = 4000;

function detectAccountable() {
  // Fast path FIRST, on EVERY call: the content script sets this marker on
  // documentElement at document_start, so it's authoritative + synchronous. Checking
  // it ahead of the cache means a stale negative can't strand the page once the CS has
  // injected (e.g. a gcuFetch that raced ahead of injection on a fast cache-served PWA).
  try {
    const marker = document.documentElement?.dataset?.gcuAcc;
    if (marker) { accDetection = Promise.resolve(marker); return accDetection; }
  } catch { /* no document (e.g. worker scope) — fall through to the ping path */ }

  if (accDetection) return accDetection;   // a prior POSITIVE — never a cached negative

  // A NEGATIVE is NOT cached as the detection promise: a flaky 200ms ping against a
  // cold MV3 service worker can resolve false, and caching that would silently strand
  // polling on direct fetch (CORS failures) for the whole session — exactly what bit
  // weir's feeds. Instead re-ping on the next call, but no more often than the cooldown
  // so a genuinely bridgeless page doesn't ping on every single fetch.
  if (Date.now() - lastNegativeAt < NEGATIVE_COOLDOWN) return Promise.resolve(false);

  const pending = (async () => {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(false);
      }, PING_TIMEOUT);
      function handler(e) {
        if (e.source !== window) return;
        if (e.data?.type !== 'gcu-acc-pong' || e.data?.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(e.data.version || true);
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: 'gcu-acc-ping', id }, '*');
    });
  })();
  accDetection = pending;
  pending.then((res) => {
    // Only keep the cache if it confirmed the bridge; a negative clears it (and starts
    // the cooldown) so the next call re-detects once the SW is warm / CS has injected.
    if (accDetection === pending && !res) { accDetection = null; lastNegativeAt = Date.now(); }
  });
  return pending;
}

async function viaAccountable(url, opts = {}) {
  const id = crypto.randomUUID();
  // Serialize the body before constructing the message — failures here
  // (FormData / streams) need to reject the gcuFetch promise, not get
  // swallowed in the postMessage round-trip.
  const { body, bodyEncoding } = await serializeRequestBody(opts.body);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Accountable request timed out'));
    }, REQUEST_TIMEOUT);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.type !== 'gcu-acc-response' || e.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      // Reject ONLY on a genuine bridge/relay error (origin denied, the SW's fetch
      // threw, relay unavailable) — those carry an `error` string. Everything else is a
      // real HTTP response and must be RESOLVED whatever the status: `e.data.ok` only
      // reflects 2xx, but a 304/404/301 is a valid brokered response the caller has to
      // act on (e.g. a conditional-GET poll treats 304 as "unchanged"). Rejecting on
      // !ok turned every 304 into a spurious failure → consumers fell back to a
      // CORS-doomed direct fetch.
      if (e.data.error != null) {
        reject(new Error(e.data.error));
        return;
      }
      // Three shapes the response body can take:
      //   - string + bodyEncoding 'text' or undefined → pass to Response as-is
      //   - ArrayBuffer (new CS path, structured-clone)  → pass to Response as-is
      //   - string + bodyEncoding 'base64' (old CS path) → decode first
      let resBody = e.data.body;
      if (e.data.bodyEncoding === 'base64' && typeof resBody === 'string') {
        resBody = arrayBufferFromBase64(resBody);
      }
      // 204/205/304 are null-body statuses — the Response constructor throws on a
      // non-null body for them, so force null defensively.
      const nullBody = e.data.status === 204 || e.data.status === 205 || e.data.status === 304;
      const res = new Response(nullBody ? null : resBody, {
        status: e.data.status,
        statusText: e.data.statusText,
        headers: e.data.headers
      });
      // A manually-constructed Response has url === '' (the browser only sets it on
      // real network responses). The SW sends back the FINAL (post-redirect) url, so
      // surface it — callers rely on response.url to resolve redirects (an own data
      // prop shadows the inherited Response.prototype.url getter).
      if (e.data.url) {
        try { Object.defineProperty(res, 'url', { value: e.data.url, configurable: true }); } catch { /* read-only env — leave '' */ }
      }
      if (e.data.receipt) res.receipt = e.data.receipt; // provenance receipt (when {receipt:true})
      resolve(res);
    }
    window.addEventListener('message', handler);
    window.postMessage({
      type: 'gcu-acc-request',
      id,
      url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body,
      bodyEncoding,
      receipt: !!opts.receipt
    }, '*');
  });
}

// Streaming variant: resolves with a Response whose body is a ReadableStream fed by
// chunk messages, so a big body is consumed incrementally instead of buffered. Waits
// for the head (status/headers) before constructing the Response; errors before the
// head reject gcuFetch (so it can fall back), errors after the head error the stream.
async function viaAccountableStream(url, opts = {}) {
  const id = crypto.randomUUID();
  const { body, bodyEncoding } = await serializeRequestBody(opts.body);

  return new Promise((resolve, reject) => {
    let controller = null;
    let gotHead = false;
    const headTimer = setTimeout(() => {
      if (!gotHead) { window.removeEventListener('message', onMsg); reject(new Error('Accountable stream timed out')); }
    }, REQUEST_TIMEOUT);

    function onMsg(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.id !== id) return;
      if (d.type === 'gcu-acc-stream-head') {
        gotHead = true; clearTimeout(headTimer);
        const nullBody = d.status === 204 || d.status === 205 || d.status === 304;
        const stream = nullBody ? null : new ReadableStream({
          start(c) { controller = c; },
          // consumer cancelled → tell the SW to stop fetching (it aborts on port disconnect)
          cancel() { window.removeEventListener('message', onMsg); window.postMessage({ type: 'gcu-acc-stream-cancel', id }, '*'); }
        });
        if (nullBody) window.removeEventListener('message', onMsg);
        const res = new Response(stream, { status: d.status, statusText: d.statusText, headers: d.headers });
        if (d.url) { try { Object.defineProperty(res, 'url', { value: d.url, configurable: true }); } catch { /* read-only */ } }
        resolve(res);
      } else if (d.type === 'gcu-acc-stream-chunk') {
        if (controller) { try { controller.enqueue(new Uint8Array(d.chunk)); } catch { /* closed */ } }
      } else if (d.type === 'gcu-acc-stream-end') {
        window.removeEventListener('message', onMsg);
        if (controller) { try { controller.close(); } catch { /* already */ } }
      } else if (d.type === 'gcu-acc-stream-error') {
        window.removeEventListener('message', onMsg); clearTimeout(headTimer);
        if (controller) { try { controller.error(new Error(d.error)); } catch { /* already */ } }
        else reject(new Error(d.error)); // before head → let gcuFetch fall back
      }
    }

    window.addEventListener('message', onMsg);
    window.postMessage({
      type: 'gcu-acc-stream-start', id, url,
      method: opts.method || 'GET', headers: opts.headers || {}, body, bodyEncoding
    }, '*');
  });
}

export async function hasAccountable() {
  return !!(await detectAccountable());
}

export async function accountableVersion() {
  const v = await detectAccountable();
  return typeof v === 'string' ? v : null;
}

// Invalidate the bridge's stored response cache. With a URL, drops only
// that entry; without, drops everything. Resolves with the count cleared,
// or 0 if no bridge is installed. Rejects if the bridge is installed but
// refuses (e.g. origin not allowed).
export async function clearAccountableCache(url) {
  if (!(await detectAccountable())) return 0;
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Accountable cache clear timed out'));
    }, REQUEST_TIMEOUT);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.type !== 'gcu-acc-cache-clear-response' || e.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.cleared ?? 0);
      else reject(new Error(e.data.error));
    }
    window.addEventListener('message', handler);
    const msg = { type: 'gcu-acc-cache-clear', id };
    if (url) msg.url = url;
    window.postMessage(msg, '*');
  });
}

// Ask Accountable to open its options/grant page. A page can't request host
// permissions itself — only the extension can, on a user gesture there — so this
// is how a consumer (weir's settings) summons the grant surface. Resolves true if
// the broker acknowledged, false if it isn't installed / didn't answer.
export async function openAccountableSetup() {
  if (!(await detectAccountable())) return false;
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', handler); resolve(false); }, 2000);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.type !== 'gcu-acc-open-setup-response' || e.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(!!e.data.ok);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'gcu-acc-open-setup', id }, '*');
  });
}

// Reject body types we can't carry across the bridge wire — *before*
// the bridge-vs-direct decision, so behavior doesn't depend on whether
// the extension happens to be installed. (fetch() handles FormData and
// ReadableStream natively; we don't.)
function rejectUnsupportedBody(body) {
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new TypeError('gcuFetch: FormData bodies are not supported. Wrap in a Blob with an explicit content-type, or serialize yourself.');
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new TypeError('gcuFetch: streaming request bodies are not supported.');
  }
}

// Opt-in diagnostics: set `window.__gcuDiag = []` and every gcuFetch records which
// path it took and why (detection result, bridge errors, final outcome). Zero cost
// when the array isn't present. Drains old entries past 500 so it can't grow unbounded.
function diagPush(entry) {
  try {
    const d = (typeof window !== 'undefined') && window.__gcuDiag;
    if (Array.isArray(d)) { d.push({ t: Date.now(), ...entry }); if (d.length > 500) d.splice(0, d.length - 500); }
  } catch { /* ignore */ }
}

export async function gcuFetch(url, opts = {}) {
  rejectUnsupportedBody(opts.body);
  const detected = await detectAccountable();
  const via = opts.stream ? viaAccountableStream : viaAccountable;
  if (detected) {
    try {
      const r = await via(url, opts);
      diagPush({ url, detected, path: opts.stream ? 'bridge-stream' : 'bridge', status: r.status });
      return r;
    } catch (e1) {
      // A real access DECISION (origin/target denied) must SURFACE — never silently fall
      // back to a CORS-doomed direct fetch, which hides the reason and defeats the grant
      // flow (the caller should see it and can openAccountableSetup()).
      if (String(e1?.message || '').startsWith('accountable:')) throw e1;
      // A cold MV3 service worker can drop the first relayed request(s) while it
      // wakes — the content script's chrome.runtime.sendMessage throws and the relay
      // returns "Accountable unavailable", so viaAccountable rejects fast. This is common on a
      // burst (e.g. a feed poll cycle) against an idle SW. The first attempt woke it,
      // so retry once before giving up to a (CORS-doomed) direct fetch.
      try {
        await new Promise((r) => setTimeout(r, 250));
        const r = await via(url, opts);
        diagPush({ url, detected, path: opts.stream ? 'bridge-stream-retry' : 'bridge-retry', status: r.status });
        return r;
      } catch (e2) {
        diagPush({ url, detected, path: 'direct', e1: String(e1?.message ?? e1), e2: String(e2?.message ?? e2) });
        // Both bridge attempts failed — fall through to direct fetch.
      }
    }
  } else {
    diagPush({ url, detected, path: 'direct-undetected' });
  }
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (typeof window !== 'undefined' && window.GCU_PROXY) {
      return fetch(`${window.GCU_PROXY}?url=${encodeURIComponent(url)}`, opts);
    }
    throw e;
  }
}
