// Dropbox sync auth — PKCE crypto correctness (SYNC.md). The live OAuth + vault are
// browser-only (validated by examples/dropbox-spike.html); this guards the one piece a
// bug would silently break: the S256 challenge encoding. Run: node tools/smoke-dropbox.mjs
import assert from 'node:assert';
import { dbxB64url, dbxChallenge, dbxRandVerifier } from '../src/js/dropbox.js';

// RFC 7636 Appendix B — the canonical PKCE S256 vector. If our challenge matches this,
// the SHA-256 + base64url-without-padding pipeline is correct (a '-' in the expected
// output also proves the url-safe alphabet).
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
assert.equal(await dbxChallenge(RFC_VERIFIER), RFC_CHALLENGE, 'PKCE S256 challenge matches RFC 7636 vector');

// base64url is url-safe + unpadded
const enc = dbxB64url(new Uint8Array([255, 254, 253, 0, 1, 2, 250]));
assert.ok(!/[+/=]/.test(enc), 'b64url has no +, /, or = padding');
assert.ok(/^[A-Za-z0-9_-]+$/.test(enc), 'b64url uses only url-safe chars');

// verifier: url-safe, RFC-length (43..128), and actually random
const v = dbxRandVerifier();
assert.ok(/^[A-Za-z0-9_-]+$/.test(v), 'verifier is url-safe');
assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length} within RFC 7636 43..128`);
assert.notEqual(dbxRandVerifier(), v, 'verifiers are random, not constant');

console.log('dropbox (sync auth PKCE) smoke ok');
