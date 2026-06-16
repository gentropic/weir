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
//
// `series` + `seq` (a series title + volume number) belong to a numbered set — a
// manga/book series like YKK. Supplied via opts (the caller pulls them from the
// item's `structured`) or carried on the card. They keep a series TOGETHER and in
// VOLUME order on the shelf: the per-volume year would otherwise scatter a set
// (reprints share a year; first editions span years). Absent for everything that
// isn't a numbered series, where the call number is unchanged.
export function callNumber(card, { codes = DOMAIN_CODES, series, seq } = {}) {
  const f = (card && card.facets) || {};
  const dc = (card && card.dublin_core) || {};
  const st = (card && card.structured) || {};
  const domain = (f.domain || [])[0] || null;
  const sub = (f.entity || [])[0] || (f.process || [])[0] || null;
  const form = (f.form || [])[0] || null;
  const creator = (dc.creator || [])[0] || null;
  const year = (String(dc.date || '').match(/\d{4}/) || [null])[0];
  const ser = ((series ?? st.series) ? String(series ?? st.series).trim() : '') || null;
  const rawSeq = seq ?? st.seq;
  const seqN = (rawSeq === 0 || rawSeq) && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : null;
  return {
    domain: domain ? codeFor(domain, codes) : 'GEN',
    sub: sub ? codeFor(sub, codes) : null,
    form: FORM_CODE[form] || (form ? String(form)[0].toUpperCase() : null),
    cutter: cutter(creator),
    year,
    series: ser,
    seq: seqN,
    terms: { domain, sub, form, creator, series: ser },   // for the readable rendering
  };
}

const SEP = '·';
// Coded — spine-writable, Dewey-recognition feel. A series volume ends in its set
// code + zero-padded volume (`…·YOK·v.03`) — the volume is the disambiguator, so the
// year drops off the spine; everything else ends in the 2-digit year as before.
export function renderCoded(cn) {
  const head = [cn.domain, cn.sub, cn.form, cn.cutter];
  const tail = cn.seq != null
    ? [cn.series ? deriveCode(cn.series) : null, `v.${String(cn.seq).padStart(2, '0')}`]
    : [cn.year && cn.year.slice(2)];
  return [...head, ...tail].filter(Boolean).join(SEP);
}
// Readable — full words for the weir UI. A series volume reads "… · book Ashinano · YKK vol. 3"
// (the set gets its own `·` segment; the per-volume year drops off in favour of the volume).
export function renderReadable(cn) {
  const t = cn.terms || {};
  const subject = [t.domain, t.sub].filter(Boolean).map(titleCase).join(' : ');
  const tail = [t.form, surnameOf(t.creator) || null, cn.seq != null ? null : cn.year].filter(Boolean).join(' ');
  const setSeg = cn.seq != null ? [t.series || null, `vol. ${cn.seq}`].filter(Boolean).join(' ') : null;
  return [subject || 'Unclassified', tail, setSeg].filter(Boolean).join(' · ');
}
// Sort key — coded, uppercase, padded so a plain string sort wanders subject →
// subdomain → form → author → SERIES → volume → year (missing fields sink to the
// end). The series segment ('' for standalone, so they precede an author's series)
// + the zero-padded volume keep a set together and in order; year is the final
// tiebreak (so non-series behaviour — sort within an author by year — is unchanged).
export function sortKey(cn) {
  // Leading rank digit so a standalone book ('0') always precedes a series ('1…'),
  // regardless of the SEP char's collation — then the set code orders series among
  // themselves. (A bare '' would collide with SEP and sort high.)
  const ser = cn.series ? '1' + deriveCode(cn.series) : '0';
  const seqPad = cn.seq != null ? String(cn.seq).padStart(4, '0') : '0000';
  return [cn.domain || 'ZZZ', cn.sub || 'ZZZ', cn.form || 'Z', cn.cutter || 'ZZZ', ser, seqPad, cn.year || '9999'].join(SEP);
}
