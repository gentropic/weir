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

// Main classes & divisions — a deliberate disciplinary SEQUENCE so the shelf groups
// related fields instead of scattering them alphabetically (geology/geostatistics/
// mining together; CS/programming together). glass's OWN backbone (the universal
// "main class · division" pattern Dewey/LC/UDC all use) — NOT Dewey's copyrighted
// schedules. TWO digits: the first is the main class (0–9), the second a division
// within it; most domains stay at `x0` (the class's general bucket) and only the
// dense classes (3 science, 5 technology, 7 letters) split. Class 00 (general)
// doubles as the fallback for any unmapped domain. The class LEADS the call number.
// (The "right" long-term home for this hierarchy is the SKOS vocab's broader-terms;
// this map is the pragmatic, derived stand-in until then — see GLASS notes.)
export const CLASS_NAMES = {
  '00': 'General & reference', '10': 'Philosophy & psychology', '20': 'Social sciences',
  '30': 'Science (general)', '31': 'Mathematics', '32': 'Statistics', '33': 'Physical sciences',
  '35': 'Biology & nature', '36': 'Earth sciences', '38': 'Astronomy & space',
  '40': 'Medicine & health',
  '50': 'Technology (general)', '51': 'Computer science & software', '52': 'Data & AI',
  '53': 'Electronics & hardware', '54': 'Engineering', '55': 'Networking & security',
  '60': 'Arts & design',
  '70': 'Literature', '71': 'Language', '72': 'Comics & manga',
  '80': 'History', '90': 'Recreation & practical',
};
const DOMAIN_CLASS = {
  // 00 — General & reference (also the fallback for anything unmapped)
  reference: '00', academia: '00', news: '00', journalism: '00', media: '00', publishing: '00', writing: '00', communication: '00', information: '00',
  // 10 — Philosophy & psychology
  philosophy: '10', psychology: '10', ethics: '10', logic: '10', 'cognitive science': '10', neuroscience: '10',
  // 20 — Social sciences
  'social sciences': '20', sociology: '20', anthropology: '20', economics: '20', finance: '20', business: '20', marketing: '20', management: '20',
  politics: '20', government: '20', law: '20', 'international relations': '20', geopolitics: '20', military: '20', education: '20',
  'urban studies': '20', 'urban planning': '20', society: '20', culture: '20', religion: '20', 'human rights': '20', policy: '20', activism: '20', labor: '20', 'social media': '20',
  // 3x — Mathematics & natural science (split)
  science: '30',
  mathematics: '31',
  statistics: '32',
  physics: '33', chemistry: '33',
  biology: '35', nature: '35', environment: '35', 'environmental science': '35', ecology: '35', agriculture: '35', climate: '35',
  geology: '36', geostatistics: '36', geography: '36', geospatial: '36', cartography: '36', 'remote sensing': '36', mining: '36',
  astronomy: '38', space: '38',
  // 40 — Medicine & health
  medicine: '40', health: '40', healthcare: '40', 'public health': '40', 'mental health': '40', nutrition: '40',
  pharmacology: '40', nursing: '40', dentistry: '40', epidemiology: '40', anatomy: '40', physiology: '40', fitness: '40', wellness: '40',
  // 5x — Technology & engineering (split)
  technology: '50', retrocomputing: '50', diy: '50', maker: '50', '3d printing': '50', 'home automation': '50', infrastructure: '50', simulation: '50', energy: '50',
  computing: '51', 'computer science': '51', programming: '51', software: '51', 'software development': '51', 'software engineering': '51', 'web development': '51', devops: '51', databases: '51', 'cloud computing': '51',
  'data science': '52', 'machine learning': '52', 'artificial intelligence': '52',
  electronics: '53', hardware: '53', 'embedded systems': '53', iot: '53',
  engineering: '54', 'mechanical engineering': '54', manufacturing: '54', robotics: '54', aerospace: '54', automotive: '54', aviation: '54',
  networking: '55', cybersecurity: '55', security: '55', cryptography: '55', telecommunications: '55',
  // 60 — Arts & design
  art: '60', arts: '60', design: '60', architecture: '60', photography: '60', music: '60', film: '60', animation: '60', television: '60',
  graphics: '60', 'computer graphics': '60', typography: '60', fashion: '60', theater: '60', audio: '60', entertainment: '60', comedy: '60', humor: '60',
  // 7x — Letters (split: literature / language / comics)
  literature: '70', fiction: '70', 'science fiction': '70', fantasy: '70', nonfiction: '70', poetry: '70',
  language: '71', linguistics: '71',
  manga: '72', comics: '72', anime: '72',
  // 80 — History
  history: '80', archaeology: '80',
  // 90 — Recreation & practical
  cooking: '90', food: '90', crafts: '90', crafting: '90', craft: '90', craftsmanship: '90', woodworking: '90', metalworking: '90',
  gardening: '90', hobbies: '90', hobby: '90', gaming: '90', sports: '90', travel: '90', tourism: '90', collectibles: '90', pets: '90',
  outdoor: '90', 'home improvement': '90', furniture: '90', stationery: '90', coffee: '90', lifestyle: '90', productivity: '90', 'self-help': '90',
};
// The 2-digit class for a domain TERM (the readable term, not its code). Unmapped → '00' (general).
export function classOf(term) {
  if (!term) return '00';
  return DOMAIN_CLASS[String(term).toLowerCase().trim()] || '00';
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
  return [cn.cls || '00', cn.domain || 'ZZZ', cn.sub || 'ZZZ', cn.form || 'Z', cn.cutter || 'ZZZ', ser, seqPad, cn.year || '9999'].join(SEP);
}
