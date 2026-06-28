// gen-gazetteer.mjs — BUILD-TIME generator for the spatial containment gazetteer (GLASS §7 / the
// thesaurus arc, ROADMAP "spatial hierarchy"). Reads the CC0 CIA World Factbook pack from the
// sibling gcu-library repo (country→region + capital), maps factbook regions → weir's continents,
// adds a small CURATED supplement for what a countries+capitals dataset lacks (US states, major
// non-capital cities, a few sub-national units — the corpus is US-heavy), and emits a vendored
// `src/js/gazetteer.js` (a flat term→broader map). Run once when the data changes:
//   node tools/gen-gazetteer.mjs   (needs ../gcu-library checked out)
// The OUTPUT is committed; gcu-library is a build-time-only dependency (no runtime/ship dep).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FB = path.join(here, '..', '..', 'gcu-library', 'data', 'factbook', 'records.json');
const OUT = path.join(here, '..', 'src', 'js', 'gazetteer.js');

// factbook `region` slug → weir's seeded continent term
const REGION_CONTINENT = {
  'africa': 'africa', 'antarctica': 'antarctica', 'australia-oceania': 'oceania',
  'central-america-n-caribbean': 'north america', 'central-asia': 'asia',
  'east-n-southeast-asia': 'asia', 'europe': 'europe', 'middle-east': 'asia',
  'north-america': 'north america', 'south-america': 'south america', 'south-asia': 'asia',
};
// factbook country `name` → weir's term form, only where they differ (factbook uses "Korea, South")
const COUNTRY_ALIAS = {
  'korea, south': 'south korea', 'korea, north': 'north korea',
  'congo, democratic republic of the': 'democratic republic of the congo',
  'congo, republic of the': 'republic of the congo', 'bahamas, the': 'bahamas',
  'gambia, the': 'gambia', 'czechia': 'czech republic', 'burma': 'myanmar',
  'united states': 'united states', 'holy see (vatican city)': 'vatican city',
};
const norm = (s) => String(s || '').toLowerCase().trim();
// a capital field may read "Tirana (Tirane)" / "Washington, DC" / "Pretoria (administrative); ..."
const cleanCapital = (s) => norm(String(s || '').split(/[;(]/)[0].replace(/,\s*dc$/i, '').replace(/,.*$/, '')).trim();

const recs = JSON.parse(fs.readFileSync(FB, 'utf8'));
const gaz = {};   // term → its single broader (parent) term
let countries = 0, capitals = 0;
for (const r of recs) {
  const country = COUNTRY_ALIAS[norm(r.name)] || norm(r.name);
  const continent = REGION_CONTINENT[r.region];
  if (country && continent) { gaz[country] = continent; countries++; }
  const cap = cleanCapital(r.capital);
  if (cap && country && cap !== country && !gaz[cap]) { gaz[cap] = country; capitals++; }
}

// ── curated supplement — what countries+capitals can't give, weighted to the actual corpus ──
const US_STATES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
for (const s of US_STATES) gaz[s] = 'united states';
// major non-capital cities → country (or state where the corpus thinks city-in-state)
const CITY_PARENT = {
  'new york city': 'united states', 'los angeles': 'united states', 'chicago': 'united states',
  'san francisco': 'united states', 'seattle': 'united states', 'boston': 'united states',
  'philadelphia': 'united states', 'miami': 'united states', 'houston': 'united states',
  'dallas': 'united states', 'atlanta': 'united states', 'denver': 'united states',
  'brooklyn': 'new york city', 'manhattan': 'new york city',
  'hong kong': 'china', 'shanghai': 'china', 'shenzhen': 'china', 'guangzhou': 'china',
  'mumbai': 'india', 'bangalore': 'india', 'delhi': 'india', 'kolkata': 'india', 'chennai': 'india',
  'montreal': 'canada', 'toronto': 'canada', 'vancouver': 'canada',
  'osaka': 'japan', 'kyoto': 'japan', 'yokohama': 'japan',
  'munich': 'germany', 'frankfurt': 'germany', 'hamburg': 'germany',
  'barcelona': 'spain', 'milan': 'italy', 'manchester': 'united kingdom', 'glasgow': 'united kingdom',
  'sao paulo': 'brazil', 'rio de janeiro': 'brazil', 'sydney': 'australia', 'melbourne': 'australia',
  'dubai': 'united arab emirates', 'istanbul': 'turkey', 'st. petersburg': 'russia',
};
Object.assign(gaz, CITY_PARENT);
// sub-national / constituent units → parent
const SUBNATIONAL = { 'england': 'united kingdom', 'scotland': 'united kingdom', 'wales': 'united kingdom', 'northern ireland': 'united kingdom', 'puerto rico': 'united states', 'greenland': 'denmark', 'taiwan': 'asia', 'palestine': 'asia', 'tibet': 'china' };
Object.assign(gaz, SUBNATIONAL);

const sorted = {}; for (const k of Object.keys(gaz).sort()) sorted[k] = gaz[k];
const banner = `// gazetteer.js — GENERATED by tools/gen-gazetteer.mjs (do not edit by hand). Spatial containment\n// for the GLASS §7 thesaurus: a flat { term → broader } map (continent ⊃ country ⊃ capital/city;\n// US states ⊃ united states). Source: CC0 CIA World Factbook (gcu-library) + a curated supplement.\n// Applied to the corpus's actual spatial terms by store.linkSpatialGazetteer() / weir_buildGazetteer.\n`;
const body = `export const GAZETTEER = ${JSON.stringify(sorted, null, 0)};\n`;
fs.writeFileSync(OUT, banner + body);
console.log(`gen-gazetteer: ${Object.keys(sorted).length} entries (${countries} countries, ${capitals} capitals, ${US_STATES.length} US states, ${Object.keys(CITY_PARENT).length} cities) → ${path.relative(path.join(here, '..'), OUT)}`);
