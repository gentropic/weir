// LLM provider client — OpenAI chat-completions shape, one call for all of them.
// Adopted + adapted from @gcu/patchbay (401/src/providers.js), made weir-native.
// `fetch` is injected (gcuFetch in the app, so calls go through the bridge and
// dodge CORS — add api.groq.com / nano-gpt.com to the bridge allowlist once;
// http://localhost is already allowlisted, so local Ollama works out of the box).

export const PROVIDERS = {
  ollama: { name: 'Ollama', base: 'http://localhost:11434', path: '/v1/chat/completions', needsKey: false, local: true, defaultModel: 'llama3.1' },
  nanogpt: { name: 'NanoGPT', base: 'https://nano-gpt.com', path: '/api/v1/chat/completions', usagePath: '/api/subscription/v1/usage', needsKey: true, defaultModel: 'kimi-k2.6' },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai', path: '/v1/chat/completions', needsKey: true, defaultModel: 'llama-3.3-70b-versatile' },
  custom: { name: 'Custom', base: '', path: '', needsKey: false, defaultModel: '' },
};

// nano-gpt bills INPUT tokens, ×2 for these models — used by the usage ledger.
export function inputMultiplier(provider, model) {
  return provider === 'nanogpt' && /glm-?5\.1|deepseek-v4-pro/i.test(model || '') ? 2 : 1;
}

function endpoint(provider, baseUrl) {
  const P = PROVIDERS[provider] || PROVIDERS.custom;
  if (provider === 'custom' || provider === 'ollama') return (baseUrl || P.base).replace(/\/$/, '') + (P.path || '/v1/chat/completions');
  return P.base + P.path;
}

// One chat completion. Returns { content, usage, model, provider, latencyMs }.
export async function chat(opts = {}) {
  const { provider = 'ollama', model, key, baseUrl, messages, temperature = 0, maxTokens, json = false, signal } = opts;
  const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('no fetch available');
  const P = PROVIDERS[provider] || PROVIDERS.custom;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const body = { model: model || P.defaultModel, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };
  const t0 = Date.now();
  const res = await f(endpoint(provider, baseUrl), { method: 'POST', headers, body: JSON.stringify(body) , signal });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`${P.name} ${res.status}: ${String(t).slice(0, 200)}`); }
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage || {},
    model: data.model || body.model,
    provider,
    latencyMs: Date.now() - t0,
  };
}

// nano-gpt subscription gauge. Docs disagree on shape (see weir-llm-usage-providers
// memory), so parse defensively: prefer weekly input tokens, fall back to
// daily/monthly. Returns { kind, used, remaining, percentUsed, resetAt } or null.
export async function fetchUsageGauge(provider, key, opts = {}) {
  const P = PROVIDERS[provider];
  if (!P || !P.usagePath || !key) return null;
  const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  try {
    const res = await f(P.base + P.usagePath, { headers: { Authorization: `Bearer ${key}` } });
    if (!res || !res.ok) return null;
    const d = await res.json();
    const pick = (o) => (o && (o.used != null || o.remaining != null)) ? o : null;
    const w = pick(d?.usage?.weeklyInputTokens) || pick(d?.weeklyInputTokens);
    if (w) return { kind: 'weeklyInputTokens', ...w };
    const day = pick(d?.daily) || pick(d?.usage?.daily);
    if (day) return { kind: 'daily', ...day };
    const mon = pick(d?.monthly) || pick(d?.usage?.monthly);
    if (mon) return { kind: 'monthly', ...mon };
    return null;
  } catch { return null; }
}
