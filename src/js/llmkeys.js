// LLM API keys — stored in OPFS (origin-private), deliberately SEPARATE from
// weir's VFS store: keys never ride along in exportAll backups or the FSA-mounted
// folder you might sync. Your catalog travels; your secrets don't.
// (Adopted from @gcu/patchbay's vault posture; passphrase-encryption at rest is a
// noted follow-up — OPFS origin-isolation is the v1 boundary.)

const FILE = 'weir-llm-keys.json';

async function _read() {
  try {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(FILE);
    return JSON.parse(await (await fh.getFile()).text());
  } catch { return {}; }
}
async function _write(obj) {
  const dir = await navigator.storage.getDirectory();
  const fh = await dir.getFileHandle(FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

export async function getKey(provider) { return (await _read())[provider] || ''; }
export async function hasKey(provider) { return !!(await getKey(provider)); }
export async function saveKey(provider, key) {
  const k = await _read();
  if (key) k[provider] = key; else delete k[provider];
  await _write(k);
}
