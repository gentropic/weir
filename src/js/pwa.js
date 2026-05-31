// PWA glue — registers the service worker and surfaces a "reload to update"
// toast when the SW reports the shell bytes changed (adapted from @gcu/ep).
// No-op on file:// (service workers need http(s)); weir still works fully there,
// just without offline caching or install. Requesting persistent storage happens
// in boot; being a controlled PWA makes the browser grant it readily.

function showToast() { document.getElementById('update-toast')?.classList.add('on'); }
function hideToast() { document.getElementById('update-toast')?.classList.remove('on'); }

// Tell the SW whether to background-refresh the shell on each load.
export function setAutoCheck(value) {
  navigator.serviceWorker?.controller?.postMessage({ type: 'weir:set-auto-check', value: !!value });
}

// Ask the SW to revalidate the shell now; resolves when it replies. If a new
// build is found the SW posts weir:update-available → the toast shows.
export function checkForUpdateNow() {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) { resolve(null); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => { if (e.data?.type === 'weir:check-complete') resolve(e.data.at); };
    ctrl.postMessage({ type: 'weir:check-now' }, [ch.port2]);
    setTimeout(() => resolve(null), 8000);   // don't hang if the SW is silent
  });
}

export function initPwa() {
  document.getElementById('update-reload')?.addEventListener('click', () => location.reload());
  document.getElementById('update-dismiss')?.addEventListener('click', hideToast);

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* registration failed — app still works */ });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'weir:update-available') showToast();
  });
}
