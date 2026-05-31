// Pure presentation helpers (SPEC §4). No DOM — node-testable.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Relative within 7 days ("2h", "3d"), then absolute ("May 12"), then with year.
export function relativeTime(ts, nowMs = Date.now()) {
  if (ts == null) return '';
  const sec = Math.round((nowMs - ts) / 1000);
  if (sec < 45) return 'now';
  if (sec < 5400) return `${Math.max(1, Math.round(sec / 60))}m`;
  const hr = Math.round(sec / 3600);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day <= 7) return `${day}d`;
  const d = new Date(ts);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(nowMs).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

export function isoTitle(ts) { return ts != null ? new Date(ts).toISOString() : ''; }

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${u[i]}`;
}

export function fmtDuration(sec) {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtCount(n) {
  if (n == null || Number.isNaN(n)) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Daily counts for the last `days` days from a list of epoch-ms timestamps.
export function dailyCounts(timestamps, days = 7, nowMs = Date.now()) {
  const out = new Array(days).fill(0);
  const startOfToday = new Date(nowMs); startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  for (const ts of timestamps) {
    const d = Math.floor((t0 - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
    const idx = days - 1 - d;
    if (idx >= 0 && idx < days) out[idx]++;
  }
  return out;
}

// SVG polyline points for a sparkline of `values`.
export function sparkPoints(values, w = 44, h = 13) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
}
