// PWA glue — registers the service worker and surfaces a "reload to update"
// toast when the SW reports the shell bytes changed (adapted from @gcu/ep).
// No-op on file:// (service workers need http(s)); weir still works fully there,
// just without offline caching or install. Requesting persistent storage happens
// in boot; being a controlled PWA makes the browser grant it readily.

function showToast() { document.getElementById('update-toast')?.classList.add('on'); }
function hideToast() { document.getElementById('update-toast')?.classList.remove('on'); }

export function initPwa() {
  document.getElementById('update-reload')?.addEventListener('click', () => location.reload());
  document.getElementById('update-dismiss')?.addEventListener('click', hideToast);

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* registration failed — app still works */ });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'weir:update-available') showToast();
  });
}
