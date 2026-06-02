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

// Check for a shell update. Robust to the page not currently being CONTROLLED by
// the SW — which is a normal state for an installed PWA (a cold start, or the
// browser evicting the idle worker), NOT "no service worker". An uncontrolled
// page loaded straight from the network, so it's already current; a reload just
// re-attaches the worker. Returns { state }:
//   unsupported  — no SW capability (file:// / unsupported browser)
//   none         — no SW registered yet (reload once to register)
//   waiting      — a new worker is installed + waiting (reload to apply)
//   uncontrolled — SW registered but not driving this tab (already latest; reload to attach)
//   checked      — controlling; asked it to revalidate the shell (toast if changed)
export async function checkForUpdateNow() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return { state: 'unsupported' };
  let reg = null;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch { /* ignore */ }
  if (!reg) return { state: 'none' };
  if (reg.waiting) return { state: 'waiting' };
  try { await reg.update(); } catch { /* re-check sw.js; ignore failures */ }
  if (reg.waiting) return { state: 'waiting' };
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl) return { state: 'uncontrolled' };
  await new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => { if (e.data?.type === 'weir:check-complete') resolve(); };
    ctrl.postMessage({ type: 'weir:check-now' }, [ch.port2]);
    setTimeout(resolve, 8000);   // don't hang if the SW is silent
  });
  return { state: 'checked' };
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
