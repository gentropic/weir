// Dropbox sync auth (SYNC.md) — the CONSUMER-side OAuth for weir's cloud sync.
//
// Browser-only PKCE (S256, no client secret), proven by examples/dropbox-spike.html.
// The GCU-sync app key is a PUBLIC PKCE client_id (committable — a stranger can't get
// tokens with it: the auth code only reaches our registered redirect URIs). The
// short-lived access token lives in memory; the long-lived refresh token lives in the
// OPFS-encrypted key vault (llmkeys) — NEVER in the VFS store, so it can't ride along in
// backups, the FSA mount, or Dropbox sync (same posture as LLM keys).
//
// This module is purely the auth seam: it produces `getDropboxToken` — the `getToken()`
// callback the @gcu/vfs DropboxBackend takes. The storage primitive (DropboxBackend) and
// the sync engine are separate (DropboxBackend → @gcu/vfs via spec_inbox; engine → weir).

// PUBLIC PKCE client_id of the GCU-sync Dropbox app (App-folder access → /Apps/GCU-sync/).
// TODO: paste the GCU-sync app key here (the spike used a throwaway one). Public, committable.
const DBX_APP_KEY = 'PASTE-GCU-SYNC-APP-KEY';
const DBX_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const DBX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const DBX_SCOPES = 'files.content.write files.content.read files.metadata.read account_info.read';
const DBX_VAULT_SLOT = 'dropbox-sync';        // refresh-token slot in the OPFS vault (llmkeys)
const DBX_VERIFIER_SS = 'weir_dbx_verifier';  // sessionStorage; must survive the auth redirect

// Canonical redirect URI = weir's own app URL (origin + path, no query/hash). REGISTER
// this exact value on the GCU-sync app. Fixed (not the spike's dynamic pathname) so it's
// stable across the app and matches what you register.
function dbxRedirectUri() { return location.origin + location.pathname; }

// in-memory only: the short-lived access token + its expiry (epoch ms)
let _dbxAccess = null;

// ── PKCE helpers (exported for the smoke; S256 per RFC 7636) ──
function dbxB64url(bytes) {
  let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function dbxRandVerifier() { const a = new Uint8Array(48); crypto.getRandomValues(a); return dbxB64url(a); }
async function dbxChallenge(verifier) {
  return dbxB64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

async function _dbxTokenPost(params) {
  const r = await fetch(DBX_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dropbox token ${r.status}: ${j.error_description || j.error || 'failed'}`);
  return j;
}

// True if a refresh token is on file (i.e. sync is connected).
async function dropboxConnected() { return !!(await getKey(DBX_VAULT_SLOT)); }

// Start the PKCE flow: mint a verifier, stash it (survives the redirect), and bounce to
// Dropbox. token_access_type=offline → we get a refresh token for unattended re-auth.
async function connectDropbox() {
  if (DBX_APP_KEY.startsWith('PASTE-')) throw new Error('GCU-sync app key not set in dropbox.js');
  const verifier = dbxRandVerifier();
  sessionStorage.setItem(DBX_VERIFIER_SS, verifier);
  const url = `${DBX_AUTHORIZE}?client_id=${encodeURIComponent(DBX_APP_KEY)}&response_type=code`
    + `&token_access_type=offline&code_challenge=${await dbxChallenge(verifier)}&code_challenge_method=S256`
    + `&scope=${encodeURIComponent(DBX_SCOPES)}&redirect_uri=${encodeURIComponent(dbxRedirectUri())}`;
  location.href = url;
}

// Called on boot: if we're returning from the authorize redirect (?code=…), exchange the
// code for tokens, persist the refresh token to the vault, and strip the query. Returns
// 'connected' | 'error' | null (no redirect to handle). Safe to call on every load.
async function handleDropboxRedirect() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code'), err = p.get('error');
  if (err) { history.replaceState({}, '', dbxRedirectUri()); return 'error'; }
  if (!code) return null;
  const verifier = sessionStorage.getItem(DBX_VERIFIER_SS);
  sessionStorage.removeItem(DBX_VERIFIER_SS);
  history.replaceState({}, '', dbxRedirectUri());   // strip ?code before anything else reads the URL
  if (!verifier) return 'error';
  const j = await _dbxTokenPost({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: DBX_APP_KEY, redirect_uri: dbxRedirectUri() });
  if (j.refresh_token) await saveKey(DBX_VAULT_SLOT, j.refresh_token);
  if (j.access_token) _dbxAccess = { token: j.access_token, expires: Date.now() + ((j.expires_in || 14400) - 60) * 1000 };
  return 'connected';
}

// The getToken() the DropboxBackend consumes: return a valid access token, refreshing via
// the stored refresh token when the in-memory one is missing/expired. Throws if not connected.
async function getDropboxToken() {
  if (_dbxAccess && Date.now() < _dbxAccess.expires) return _dbxAccess.token;
  const refresh = await getKey(DBX_VAULT_SLOT);
  if (!refresh) throw new Error('dropbox sync not connected');
  const j = await _dbxTokenPost({ grant_type: 'refresh_token', refresh_token: refresh, client_id: DBX_APP_KEY });
  _dbxAccess = { token: j.access_token, expires: Date.now() + ((j.expires_in || 14400) - 60) * 1000 };
  return _dbxAccess.token;
}

// Forget the connection (clears the vault refresh token + the in-memory access token).
async function disconnectDropbox() { _dbxAccess = null; try { await saveKey(DBX_VAULT_SLOT, ''); } catch { /* best effort */ } }

export { connectDropbox, handleDropboxRedirect, getDropboxToken, disconnectDropbox, dropboxConnected, dbxRedirectUri, dbxB64url, dbxRandVerifier, dbxChallenge };
