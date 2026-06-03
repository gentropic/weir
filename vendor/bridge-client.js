// @gcu/bridge — page-side client
// Drop-in helper for GCU tools that want to fetch through the bridge when
// available, with graceful fallback when not.
//
// Usage:
//   import { gcuFetch, hasBridge } from './bridge-client.js';
//   const res = await gcuFetch('https://feeds.example.com/atom.xml');
//   const text = await res.text();
//
// Resolution order:
//   1. @gcu/bridge extension installed + this origin is allowed
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

let bridgeDetection = null;   // cached POSITIVE detection (a marker/version promise)
let lastNegativeAt = 0;       // when the last ping resolved false (for the re-detect cooldown)
const NEGATIVE_COOLDOWN = 4000;

function detectBridge() {
  // Fast path FIRST, on EVERY call: the content script sets this marker on
  // documentElement at document_start, so it's authoritative + synchronous. Checking
  // it ahead of the cache means a stale negative can't strand the page once the CS has
  // injected (e.g. a gcuFetch that raced ahead of injection on a fast cache-served PWA).
  try {
    const marker = document.documentElement?.dataset?.gcuBridge;
    if (marker) { bridgeDetection = Promise.resolve(marker); return bridgeDetection; }
  } catch { /* no document (e.g. worker scope) — fall through to the ping path */ }

  if (bridgeDetection) return bridgeDetection;   // a prior POSITIVE — never a cached negative

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
        if (e.data?.type !== 'gcu-bridge-pong' || e.data?.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(e.data.version || true);
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: 'gcu-bridge-ping', id }, '*');
    });
  })();
  bridgeDetection = pending;
  pending.then((res) => {
    // Only keep the cache if it confirmed the bridge; a negative clears it (and starts
    // the cooldown) so the next call re-detects once the SW is warm / CS has injected.
    if (bridgeDetection === pending && !res) { bridgeDetection = null; lastNegativeAt = Date.now(); }
  });
  return pending;
}

async function viaBridge(url, opts = {}) {
  const id = crypto.randomUUID();
  // Serialize the body before constructing the message — failures here
  // (FormData / streams) need to reject the gcuFetch promise, not get
  // swallowed in the postMessage round-trip.
  const { body, bodyEncoding } = await serializeRequestBody(opts.body);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('bridge request timed out'));
    }, REQUEST_TIMEOUT);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.type !== 'gcu-bridge-response' || e.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (e.data.ok) {
        // Three shapes the response body can take:
        //   - string + bodyEncoding 'text' or undefined → pass to Response as-is
        //   - ArrayBuffer (new CS path, structured-clone)  → pass to Response as-is
        //   - string + bodyEncoding 'base64' (old CS path) → decode first
        let resBody = e.data.body;
        if (e.data.bodyEncoding === 'base64' && typeof resBody === 'string') {
          resBody = arrayBufferFromBase64(resBody);
        }
        const res = new Response(resBody, {
          status: e.data.status,
          statusText: e.data.statusText,
          headers: e.data.headers
        });
        // A manually-constructed Response has url === '' (the browser only sets
        // it on real network responses). The service worker sends back the FINAL
        // (post-redirect) url, so surface it — callers rely on response.url to
        // resolve share-sheet/shortener redirects (an own data prop shadows the
        // inherited Response.prototype.url getter).
        if (e.data.url) {
          try { Object.defineProperty(res, 'url', { value: e.data.url, configurable: true }); } catch { /* read-only env — leave '' */ }
        }
        resolve(res);
      } else {
        reject(new Error(e.data.error));
      }
    }
    window.addEventListener('message', handler);
    window.postMessage({
      type: 'gcu-bridge-request',
      id,
      url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body,
      bodyEncoding
    }, '*');
  });
}

export async function hasBridge() {
  return !!(await detectBridge());
}

export async function bridgeVersion() {
  const v = await detectBridge();
  return typeof v === 'string' ? v : null;
}

// Invalidate the bridge's stored response cache. With a URL, drops only
// that entry; without, drops everything. Resolves with the count cleared,
// or 0 if no bridge is installed. Rejects if the bridge is installed but
// refuses (e.g. origin not allowed).
export async function clearBridgeCache(url) {
  if (!(await detectBridge())) return 0;
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('bridge cache clear timed out'));
    }, REQUEST_TIMEOUT);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.type !== 'gcu-bridge-cache-clear-response' || e.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.cleared ?? 0);
      else reject(new Error(e.data.error));
    }
    window.addEventListener('message', handler);
    const msg = { type: 'gcu-bridge-cache-clear', id };
    if (url) msg.url = url;
    window.postMessage(msg, '*');
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

export async function gcuFetch(url, opts = {}) {
  rejectUnsupportedBody(opts.body);
  if (await detectBridge()) {
    try {
      return await viaBridge(url, opts);
    } catch (_e) {
      // A cold MV3 service worker can drop the first relayed request(s) while it
      // wakes — the content script's chrome.runtime.sendMessage throws and the relay
      // returns "bridge unavailable", so viaBridge rejects fast. This is common on a
      // burst (e.g. a feed poll cycle) against an idle SW. The first attempt woke it,
      // so retry once before giving up to a (CORS-doomed) direct fetch.
      try {
        await new Promise((r) => setTimeout(r, 250));
        return await viaBridge(url, opts);
      } catch (_e2) {
        // Both bridge attempts failed — fall through to direct fetch.
      }
    }
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
