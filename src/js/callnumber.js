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
  manga: 'MGA', comics: 'CMX',   // curated so they don't derive to the word-like MAN / COM
  photography: 'PHO', cooking: 'COO', food: 'FOO', politics: 'POL', history: 'HIS',
  philosophy: 'PHI', psychology: 'PSY', finance: 'FIN', business: 'BUS', economics: 'ECO',
  health: 'HEA', medicine: 'MED', language: 'LAN', literature: 'LIT', education: 'EDU',
};

// Item type / form facet → one-letter form code (the middle of the address).
const FORM_CODE = {
  book: 'B', paper: 'P', article: 'A', release: 'R', video: 'V',
  track: 'K', podcast: 'D', status: 'S', commit: 'C', issue: 'I', note: 'N',
};

// Main classes — a deliberate disciplinary SEQUENCE so the shelf groups related
// fields instead of scattering them alphabetically by code (geology/geostatistics/
// mining together; CS/programming/data-science together). This is glass's OWN
// backbone (the universal "main classes" pattern that Dewey/LC/UDC all use) — NOT
// Dewey's copyrighted schedules: 9 classes, our groupings, leading the call number
// like a class digit. Class 1 doubles as the fallback for any unmapped domain.
export const CLASS_NAMES = {
  1: 'General & reference', 2: 'Philosophy & psychology', 3: 'Social sciences',
  4: 'Mathematics & natural science', 5: 'Technology & engineering', 6: 'Arts & design',
  7: 'Literature & comics', 8: 'History', 9: 'Recreation & practical',
};
const DOMAIN_CLASS = {
  // 1 — General & reference (also the fallback for anything unmapped)
  reference: '1', academia: '1', news: '1', journalism: '1', media: '1', publishing: '1', writing: '1', communication: '1', information: '1',
  // 2 — Philosophy & psychology
  philosophy: '2', psychology: '2', ethics: '2', logic: '2', 'cognitive science': '2', neuroscience: '2',
  // 3 — Social sciences
  'social sciences': '3', sociology: '3', anthropology: '3', economics: '3', finance: '3', business: '3', marketing: '3', management: '3',
  politics: '3', government: '3', law: '3', 'international relations': '3', geopolitics: '3', military: '3', education: '3',
  'urban studies': '3', 'urban planning': '3', society: '3', culture: '3', religion: '3', 'human rights': '3', policy: '3', activism: '3', labor: '3', 'social media': '3',
  // 4 — Mathematics & natural science
  mathematics: '4', statistics: '4', science: '4', physics: '4', chemistry: '4', biology: '4', astronomy: '4', space: '4',
  geology: '4', geostatistics: '4', geography: '4', geospatial: '4', cartography: '4', 'remote sensing': '4', mining: '4',
  nature: '4', environment: '4', 'environmental science': '4', ecology: '4', agriculture: '4', climate: '4',
  // 5 — Technology & engineering
  technology: '5', computing: '5', 'computer science': '5', programming: '5', software: '5', 'software development': '5', 'software engineering': '5',
  'web development': '5', 'data science': '5', 'machine learning': '5', 'artificial intelligence': '5', robotics: '5', simulation: '5',
  electronics: '5', hardware: '5', 'embedded systems': '5', iot: '5', networking: '5', cybersecurity: '5', security: '5', cryptography: '5',
  devops: '5', databases: '5', 'cloud computing': '5', engineering: '5', 'mechanical engineering': '5', manufacturing: '5',
  aerospace: '5', automotive: '5', aviation: '5', energy: '5', telecommunications: '5', retrocomputing: '5', diy: '5', maker: '5', '3d printing': '5', 'home automation': '5', infrastructure: '5',
  // 6 — Arts & design
  art: '6', arts: '6', design: '6', architecture: '6', photography: '6', music: '6', film: '6', animation: '6', television: '6',
  graphics: '6', 'computer graphics': '6', typography: '6', fashion: '6', theater: '6', audio: '6', entertainment: '6', comedy: '6', humor: '6',
  // 7 — Literature & comics
  literature: '7', fiction: '7', 'science fiction': '7', fantasy: '7', nonfiction: '7', manga: '7', comics: '7', anime: '7',
  poetry: '7', language: '7', linguistics: '7',
  // 8 — History
  history: '8', archaeology: '8',
  // 9 — Recreation & practical
  cooking: '9', food: '9', nutrition: '9', crafts: '9', crafting: '9', craft: '9', craftsmanship: '9', woodworking: '9', metalworking: '9',
  gardening: '9', hobbies: '9', hobby: '9', gaming: '9', sports: '9', travel: '9', tourism: '9', collectibles: '9', pets: '9',
  outdoor: '9', 'home improvement': '9', furniture: '9', stationery: '9', coffee: '9', lifestyle: '9', productivity: '9', 'self-help': '9',
};
// The class digit for a domain TERM (the readable term, not its code). Unmapped → '1'.
export function classOf(term) {
  if (!term) return '1';
  return DOMAIN_CLASS[String(term).toLowerCase().trim()] || '1';
}

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
    cls: classOf(domain),                                 // main-class digit — leads the shelf address
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
  const head = [cn.cls, cn.domain, cn.sub, cn.form, cn.cutter];
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
  return [cn.cls || '1', cn.domain || 'ZZZ', cn.sub || 'ZZZ', cn.form || 'Z', cn.cutter || 'ZZZ', ser, seqPad, cn.year || '9999'].join(SEP);
}
