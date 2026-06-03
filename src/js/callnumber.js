// Glass call number — a faceted, sortable SHELF ADDRESS. CC0, our own scheme
// (Ranganathan citation order), NOT Dewey: DDC rides along as display metadata,
// but the organizing system is ours. Citation order is subject-first so a shelf
// wanders by topic, with `form` in the MIDDLE so a subject's book / paper / web
// page shelve together (the "Extended-Dewey" feel, achieved through glass facets):
//
//     domain · subdomain · form · author-cutter · year
//     GEO·GES·B·SIL·23   →  Geology : Geostatistics · book · Silva 2023
//
// Derived live from a card's facets (deterministic; no storage to migrate). One
// structured value, two renderings: coded (spine labels / export) and readable
// (the weir UI). Sort by sortKey() to get the linear browse.

// Curated domain → 3-letter code (stable + legible; extensible). Anything unmapped
// derives a code from the term, so the scheme always produces something.
export const DOMAIN_CODES = {
  geology: 'GEO', geoscience: 'GEO', geophysics: 'GPH', geostatistics: 'GST',
  mining: 'MIN', statistics: 'STA', mathematics: 'MAT', 'data science': 'DSC',
  'computer science': 'CSC', programming: 'PRG', software: 'SFT', technology: 'TEC',
  hardware: 'HRD', electronics: 'ELE', 'machine learning': 'MLN', 'artificial intelligence': 'AIN',
  science: 'SCI', physics: 'PHY', chemistry: 'CHM', biology: 'BIO', astronomy: 'AST',
  engineering: 'ENG', gaming: 'GAM', music: 'MUS', film: 'FLM', art: 'ART', design: 'DSN',
  photography: 'PHO', cooking: 'COO', food: 'FOO', politics: 'POL', history: 'HIS',
  philosophy: 'PHI', psychology: 'PSY', finance: 'FIN', business: 'BUS', economics: 'ECO',
  health: 'HEA', medicine: 'MED', language: 'LAN', literature: 'LIT', education: 'EDU',
};

// Item type / form facet → one-letter form code (the middle of the address).
const FORM_CODE = {
  book: 'B', paper: 'P', article: 'A', release: 'R', video: 'V',
  track: 'K', podcast: 'D', status: 'S', commit: 'C', issue: 'I', note: 'N',
};

function deriveCode(term) {
  const s = String(term || '').toUpperCase().replace(/[^A-Z]/g, '');
  return s ? s.slice(0, 3).padEnd(3, 'X') : 'GEN';
}
function codeFor(term, map) {
  if (!term) return null;
  const k = String(term).toLowerCase().trim();
  return map[k] || deriveCode(k);
}
function surnameOf(creator) {
  const c = String(creator || '');
  return (c.includes(',') ? c.split(',')[0] : c.split(/\s+/).pop() || '').trim();
}
function cutter(creator) {
  const s = surnameOf(creator).toUpperCase().replace(/[^A-Z]/g, '');
  return s ? s.slice(0, 3).padEnd(3, 'X') : null;
}
function titleCase(s) { return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }

// Build the structured call number from a glass card. Picks the PRIMARY (first,
// salience-ordered) domain + subdomain — the Ranganathan "class where most useful"
// decision, made once. Keeps the readable terms alongside the codes for the UI.
export function callNumber(card, { codes = DOMAIN_CODES } = {}) {
  const f = (card && card.facets) || {};
  const dc = (card && card.dublin_core) || {};
  const domain = (f.domain || [])[0] || null;
  const sub = (f.entity || [])[0] || (f.process || [])[0] || null;
  const form = (f.form || [])[0] || null;
  const creator = (dc.creator || [])[0] || null;
  const year = (String(dc.date || '').match(/\d{4}/) || [null])[0];
  return {
    domain: domain ? codeFor(domain, codes) : 'GEN',
    sub: sub ? codeFor(sub, codes) : null,
    form: FORM_CODE[form] || (form ? String(form)[0].toUpperCase() : null),
    cutter: cutter(creator),
    year,
    terms: { domain, sub, form, creator },   // for the readable rendering
  };
}

const SEP = '·';
// Coded — spine-writable, Dewey-recognition feel. Year as 2 digits.
export function renderCoded(cn) {
  return [cn.domain, cn.sub, cn.form, cn.cutter, cn.year && cn.year.slice(2)].filter(Boolean).join(SEP);
}
// Readable — full words for the weir UI.
export function renderReadable(cn) {
  const t = cn.terms || {};
  const subject = [t.domain, t.sub].filter(Boolean).map(titleCase).join(' : ');
  const tail = [t.form, surnameOf(t.creator) || null, cn.year].filter(Boolean).join(' ');
  return [subject || 'Unclassified', tail].filter(Boolean).join(' · ');
}
// Sort key — coded, uppercase, padded so a plain string sort wanders subject →
// subdomain → form → author → year (missing fields sink to the end).
export function sortKey(cn) {
  return [cn.domain || 'ZZZ', cn.sub || 'ZZZ', cn.form || 'Z', cn.cutter || 'ZZZ', cn.year || '9999'].join(SEP);
}
