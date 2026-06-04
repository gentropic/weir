# `@gcu/glass` — Specification (weir implementation)

> A knowledge base built on library science, not embeddings. The catalog is the
> foundation; the library maintains itself; every classification decision is
> inspectable and reversible.

| | |
|---|---|
| **Package** | `@gcu/glass` |
| **Home implementation** | `@gcu/weir` — glass *is* what weir becomes when its archive is cataloged |
| **Format license** | CC0 — anyone may implement the catalog/facet/index format |
| **Status** | Draft. Format layer settled; cataloger + query designed; building Stage 0. |
| **Design language** | Switchboard (Barlow + Space Mono, basalt, six accents) — weir's |

> **On this document.** It supersedes the cross-session merge that ended up in
> `weir/SPEC.md §7` ("save to glass") and in a stray Downloads draft. Glass was
> originally sketched on the Auditable substrate; **weir is the actual home**, so
> this rewrite drops the Auditable-notebook assumptions and grounds every section
> in weir's existing store + item model. The *format* stays substrate-independent
> (an Auditable-based glass could be a second implementation sharing it); the
> *library* described here is weir's.

---

## 1. Thesis

Most knowledge tooling sits at one of two poles; glass rejects both:

- **Manual graphs (Obsidian).** You maintain the structure by hand-typing links.
  It is only as good as your discipline and decays the moment you stop tending it.
- **Embed-and-pray (every LLM-era tool).** Organization is delegated to an opaque
  vector space. Synonyms, homonyms, broader/narrower relations fail *silently* —
  plausible neighbors, no way to audit why.

Glass takes the third, older position from library science: **a cataloger
continuously processes inputs into a proper library** — faceted classification,
controlled vocabulary, Dublin Core metadata, a typed relation graph — maintained
by an LLM but **fully inspectable and correctable by a human.** Obsidian gives you
a graph you maintain by hand; embeddings give you a graph nobody can read; glass
gives you a library that maintains itself *and shows its work.*

### 1.1 Dumb pipes, smart service (the architectural inversion)

The opposite of RAG. RAG puts a smart pipeline in front of dumb retrieval. Glass
makes **the tooling a clean, deterministic interface to structured data, and uses
the LLM as a constrained *service*** — not an autonomous agent. Search, get,
browse, and vocabulary lookups are boring functions. Cataloging is a *bounded
call*: read one document → emit one catalog card (structured JSON) → done. The
intelligence is real but it is on a leash: it produces auditable records, never
drives the system. (Agentic use — your Claude *triggering* cataloging or running
reference queries over weir — lives on top via **webmcp**, §13; it is not the core.)

### 1.2 Why weir is the home

weir already *is* the hard part of a knowledge base: a durable, never-deleted,
full-content, deduped, FSA-mountable archive of timestamped material, with a
type/tag/provenance model that is **already a single-axis proto-facet scheme.**
The material is already here. Asking the user to "export to a separate notes app"
was always friction. So glass is not a sibling weir hands off to — **glass is weir
finishing its own model:** the archive, cataloged.

The line between *reading*, *taking a note*, and *adding to the library*
disappears. You read a feed item or write a note; the cataloger picks it up; it is
in the library. No separate ingest step.

---

## 2. LIS foundations

Glass treats a humanities discipline as an engineering dependency:

- **Faceted classification (Ranganathan).** Multiple independent axes, not one
  enumerative tree. A paper on the geostatistics of iron grade in itabirite is not
  filed under geostatistics *or* mining — it is `domain:[geostatistics, mining]`,
  `entity:[kriging, itabirite, iron-ore]`, `process:[estimation]` *simultaneously.*
  Interdisciplinary material stops being a filing problem and becomes an
  intersection query. This is why the catalog stays coherent as the collection
  grows in unexpected directions.
- **Dublin Core.** The metadata baseline (title, creator, date, type, identifier,
  source, description, language). Stable, boring, interoperable.
- **Vocabulary control / thesaurus.** Explicit broader/narrower/related/use-for
  relations between terms (§7). Exactly where embeddings fail silently and a
  thesaurus fails *loudly* — and therefore correctably.
- **The reference interview.** Figuring out what someone *needs* vs. what they
  *asked* — maps onto query decomposition (§8).

---

## 3. Where it lives in weir's store

weir's VFS already holds `/feeds`, `/items` (metadata shards), `/content`
(lazy bodies). Glass adds three trees; the layout is identical on every backend
(IDB / FSA folder), so it travels with the FSA mount:

```
/catalog/<glass_id>.json     # one catalog card per cataloged item. SOURCE OF TRUTH.
/schema/facets.json          # facet definitions, vocabulary types, scope notes
/schema/vocab/<facet>.json   # controlled terms + definitions + thesaurus per facet
/glass-index/                # DERIVED from /catalog — safe to delete + rebuild
    master.json              # flat {glass_id, title, form, confidence, date} — one-pass scannable
    facets/<facet>.json      # inverted: term → [glass_id, …]  (fast intersection)
    vocabulary.json          # every term + occurrence counts (coin-check + suggest)
    relations.json           # the typed-edge graph
```

The **documents** are weir's existing items: a fetched item's body is its
`/content/<…>.html`; a note's body is markdown (§9). The catalog card *references*
the weir item id; it never copies the body. One rule each:

- **`/catalog/` is metadata** — the single source of truth for classification.
- **`/glass-index/` is cache** — a pure function of `/catalog/`; rebuild anytime.
- **`/schema/` is config** — editing a scope note here changes how new material
  is classified. The closest thing glass has to policy.

### 3.1 Pairing
The card carries `document_ref` → the weir item id; the item record carries its
`glass_id` (a new optional field). Either side finds the other; a loose card is
never orphaned, a loose item is self-identifying.

---

## 4. The catalog card **[settled, modulo facet scheme]**

One JSON file per cataloged document. Three blocks: Dublin Core, facets, glass meta.

```json
{
  "dublin_core": {
    "title": "Ordinary vs. Simple Kriging of Fe Grade in Itabirite",
    "creator": ["Silva, M.A.", "Torres, R."],
    "date": "2023-06-15",
    "type": "article",
    "language": "en",
    "identifier": "doi:10.xxxx/xxxxx",
    "source": "Mathematical Geosciences v.55(3)",
    "description": "Compares OK and SK estimators for iron grade in itabirite-hosted profiles of the Quadrilátero Ferrífero; SK outperforms where a strong grade trend is present."
  },
  "facets": {
    "domain":   ["geostatistics", "mining"],
    "entity":   ["kriging", "itabirite", "iron-ore"],
    "process":  ["estimation", "comparison"],
    "method":   ["ordinary-kriging", "simple-kriging"],
    "scale":    ["deposit"],
    "form":     ["article"],
    "provenance": ["peer-reviewed"],
    "spatial":  ["Quadrilátero Ferrífero"],
    "temporal": ["2023"]
  },
  "glass": {
    "glass_id": "glass-20260404-001",
    "document_ref": "arxiv:2306.xxxxx",
    "cataloged": "2026-04-04",
    "cataloger": "ollama:llama-3.3 | stage0-rules",
    "confidence": 0.85,
    "needs_review": false,
    "related": [
      { "type": "extends",     "target": "glass-20260312-004" },
      { "type": "contradicts", "target": "glass-20260401-012" }
    ]
  }
}
```

- **Every facet value is an array** — a document may sit at several positions on
  any axis; nothing forces a single pick.
- `confidence` lets the cataloger flag its own uncertainty; `needs_review: true`
  drops the card into a human review queue rather than guessing silently.
- `related` uses **typed** edges (`extends` / `contradicts` / `supports` /
  `supersedes`), not undifferentiated "see also" — this is what makes
  citation-chain traversal meaningful.
- `cataloger` records *who* cataloged it (a model id, or `stage0-rules` for the
  deterministic pass) — provenance of the classification itself.

---

## 5. The facet scheme **[designed]** — and what weir pre-fills for free

| Facet | Axis | Vocabulary | weir already knows |
|---|---|---|---|
| `domain` | field | controlled | — (LLM) |
| `entity` | thing(s) | controlled, growable | tags (partial) |
| `process` | what's happening | controlled | — (LLM) |
| `method` | how | controlled, growable | — (LLM) |
| `scale` | granularity | enumerated | — (LLM) |
| `spatial` | where | free / gazetteer | — (LLM) |
| `temporal` | when | free / structured | item `published_at` |
| `form` | document genre | enumerated | **item `type`** (article/video/paper/release/…) |
| `provenance` | trust / origin | enumerated | **feed** (source + adapter + health) |

Two commitments: every value is an array; vocabularies are *typed* — some axes
(`scale`, `form`, `provenance`) are closed enumerations, others (`entity`,
`method`) are controlled but **growable** (the cataloger may coin a term, but only
after checking `vocabulary.json` and recording it — growth is auditable, not silent
drift).

**The weir head-start (Stage 0):** `form ← item.type`, `provenance ← feed`,
`temporal ← published_at`, Dublin Core `title/creator/date/identifier/source ←`
item fields, `entity ⊇` existing tags. So a card exists for *every* item with **no
LLM at all** — the language facets (`domain`/`entity`/`process`/`method`/`scale`/
`spatial`) and the abstract are what the cataloger adds (Stage 1).

### 5.1 Facet structure types — and the drilling each affords **[design frame]**

A facet is **not a flat set of values — it is values *plus a relation* between them.**
The relation's *shape* dictates the right drill UI. This is the organizing frame for
the whole "deeper drilling" arc: classify each facet's structure, then build (or
grow) the matching navigator. Five shapes cover the scheme:

| Structure | Relation | Facets | Drill |
|---|---|---|---|
| **Nominal** | none (unordered categories) | `form`, `provenance` (and `stance`, mostly) | plain term list — *correct as-is, do not force structure* |
| **Ordinal** | a line / total order | `temporal` (years), `scale` (global>…>personal) | range / slider / roll-up · ✅ temporal year-range shipped |
| **Hierarchical** | containment tree (BT/NT) | `spatial` (geo), `domain` & `entity` once vocab-linked | expand/collapse; select a parent → catch its children |
| **Cyclical** | a wheel | seasonality / month-of-year (derived from `published_at`) | wrap-around range, radial |
| **Associative** | a graph, sideways (RT) | `entity`, `process` relate *across* not *up* | follow-related / co-occurrence |

Two honest caveats this frame must carry:

1. **Structure is *supplied*, not inherent in the strings.** The cataloger hands
   back flat terms; the relations — geo containment (a gazetteer), BT/NT/RT links
   (§7), the ordinal scales — are a **separate layer built on top.** That layer *is*
   the thesaurus. So "a facet gains organization" = growing its relations, one facet
   at a time, each with the structure type that fits. It is earned, not free (hence
   spatial is real work, not a flag flip).
2. **Some facets are legitimately flat, and should stay so.** `form`/`provenance`
   are true nominal categories; imposing a hierarchy is over-engineering. The skill
   is *matching* the drill to the actual structure, never imposing one model. (Even
   nominal facets can hide a relation — `stance` has a latent sentiment ordinal,
   critical→neutral→appreciative — worth *noticing*, not worth forcing.)

Note the toolkit is broader than §7 alone: **BT/NT/RT (the thesaurus) covers
hierarchy + association; measurement structure (ordinal, cyclical) covers the
quantitative axes.** Both together are the full structural vocabulary. (See ROADMAP:
structured facets, temporal depth.)

---

## 6. The cataloger — a service, not an agent **[designed]**

A **bounded call** over the deterministic store. Triggered on demand or in batch
(directory-watch-style auto-catalog is a later option). Steps:

1. Read the document (body + the Stage-0 card as `author_hint`).
2. Generate Dublin Core + a structured abstract.
3. Assign the language facets, **checking `vocabulary.json` before coining** any
   new term and recording it if coined.
4. Propose typed `related` edges to existing cards.
5. Emit `confidence`; set `needs_review` when low.
6. Write `/catalog/<glass_id>.json`; stamp the item's `glass_id`.

The cataloger is a **prompt + structured-output schema over an OpenAI-shaped chat
endpoint** — nothing more. Providers (§11): **Ollama (local, default — zero data
egress), nano-gpt, Groq**, all OpenAI-compatible, one client. Output is validated
against the card schema and the vocabulary; on mismatch, retry or `needs_review`.

---

## 7. Controlled vocabulary & thesaurus **[designed]**

Each controlled facet carries the classic LIS relations:

- **BT / NT** — broader / narrower (`ordinary-kriging` NT-of `kriging` BT
  `interpolation`).
- **RT** — related (`variogram` RT `kriging`).
- **UF / USE** — preferred-term redirection (`semivariogram` USE `variogram`).

This solves what embeddings paper over: synonyms collapse to a preferred term,
homonyms disambiguate by facet context, and broaden/narrow is a **graph walk on
declared relations**, not a cosine guess. Lives in `/schema/vocab/<facet>.json`.

---

## 8. The query side (= weir search v2) **[designed]**

Facet intersection is the native query: *everything that is both
`domain:geostatistics` and `entity:itabirite`* is a set operation over
`/glass-index/facets/*.json` — fast, deterministic, no model. On top:

- **Broaden** a zero-result query → climb BT, drop a facet, switch axes.
- **Narrow** a fifty-result query → descend NT, intersect another facet.
- **Follow chains** → traverse `relations.json` typed edges.

These are the reference-interview moves. They are *plain functions*; an LLM
performs them only when you want natural-language search ("videos about kriging
from this month") — and even then it just *chooses* facet constraints, it doesn't
do the retrieval. **This subsumes weir's planned full-text search v2:** glass
search is LIS-shaped (faceted + thesaurus), with full-text (librarian v2, when it
lands) as one more deterministic index alongside the facet indexes.

---

## 9. Notes — first-class, as items **[designed]**

A note is **an item whose feed is you**: `type: 'note'` (→ `form: note`), a
**markdown** body, authored not fetched. It flows through the exact machinery
items already use — stored in the VFS, never-deleted, FSA-mounted, searched, and
**cataloged by the same service.** Your fleeting thoughts get faceted and filed
for free. Markdown (not Auditable cells — weir isn't Auditable-based): universal,
FSA-friendly, glass-compatible; the catalog *card* carries the structure, the body
stays plain. **Annotations** (a note bound to a specific item) are a second step.

---

## 10. The knowledge graph — emergent, not an engine **[designed]**

There is no graph database. The graph is three things that fall out of a good
catalog: (1) **facet intersection** (everything sharing a facet value is
connected — free, from the indexes), (2) **typed `related` edges** (the cataloger
proposes, you correct — auditable, not cosine), (3) **the thesaurus** (the
vocabulary graph). A force-directed **visualization** is a welcome late *view*, a
window onto the catalog — never the substance. Build the catalog well; the graph
is what it gives back.

---

## 11. LLM providers & keys **[settled direction]**

Vendor patchbay's pattern (`../etc/patchbay/401/src/{providers,vault}.js`):

- **providers** — `ollama` (local), `nanogpt`, `groq`, `custom`: all OpenAI
  chat-completions-shaped, one client, fallback model lists.
- **vault** — keys in **OPFS, encrypted PBKDF2→AES-GCM** behind an optional
  passphrase. Never localStorage, never in the catalog. **Ollama needs no key and
  ships zero data off-device — the ethos-pure default.** Cloud providers are
  opt-in, per-action, and *visible* (flight-deck: you see when data leaves).

---

## 12. Identifiers **[settled]**

`glass_id = glass-YYYYMMDD-NNN` — catalog date + daily sequence. Human-sortable,
collision-free per day, carries a weak temporal hint without pretending to be a
UUID. (weir's stable item id remains the `document_ref`.)

---

## 13. Relationship to weir & the GCU stack

- weir's **`type`** → glass **`form`**; **feed/health** → **`provenance`**;
  **tags** → seed **`entity`**; **routing rules** → a deterministic proto-cataloger
  that can pre-assign facets at insert.
- **webmcp** sits *on top* as the trigger/query layer — your Claude can say
  "catalog these 40," "re-facet the geostatistics domain," "find me X" — driving
  the librarian without the core being agentic.
- An **Auditable-based glass** could be a second implementation of this format
  (notebook-shaped); the two stay interoperable through the catalog card. weir's
  store and a `glass/` tree can share one FSA folder.
- **Prior art:** the user's *Holocene* (~2,500 links/books/papers with trust tiers
  + LLM enrichment) is structurally this system already; its trust tiers seed the
  `provenance` vocabulary, and its archive is a future backfill target for the
  cataloger.

---

## 14. Build stages

Each stage is useful alone; stop at any prefix.

- **Stage 0 — format, no AI.** Facet schema + the card format + a deterministic
  builder that emits `/catalog/<glass_id>.json` from metadata weir already has
  (`form←type`, `provenance←feed`, Dublin Core, tags→entity). A "catalog" view to
  *see* the corpus faceted. Proves the format on the real corpus, commits nothing
  irreversible. **← building now.**
- **Stage 1 — the cataloger service.** Vendor providers + vault; Ollama-first
  bounded call fills the language facets + proposes `related` edges; opt-in,
  per-item or batch, `confidence`/`needs_review` review queue.
- **Stage 2 — the query side.** Facet-intersection + thesaurus broaden/narrow
  (weir's search v2, LIS-shaped); the implicit graph becomes navigable.
- **Stage 3 — notes & graph view.** Notes-as-items + annotations; the optional
  force-graph view; webmcp triggers.

---

## 15. Open questions

1. **Identity.** This turns weir from a small reader into a self-cataloging
   knowledge base. Deliberate, but it drops the "small surface" virtue. Accepted
   in principle; revisit if the surface gets unwieldy.
2. **Auto-catalog trigger.** On-insert (every item) vs. on-save (only items you
   keep) vs. explicit/batch. Lean: **on-keep + batch** — don't LLM-process the
   whole firehose; catalog what you decide matters. Stage 0 cards exist for all;
   the *LLM* pass is selective.
3. **Provenance vocabulary.** The exact closed `provenance` set (seeded from
   Holocene tiers, never yet frozen).
4. **Index persistence.** weir's in-memory query index already exists; do the
   glass facet indexes persist to `/glass-index/` or rebuild in memory at hydrate?
   (Lean: in-memory like the item index, persist later if boot cost bites.)
5. **Vocabulary bootstrapping.** Cold-start the controlled vocabularies (seed from
   the user's domains) vs. grow purely from the corpus.

---

The neo-dadaist throughline holds: zero-dependency, single-file, browser-as-runtime,
local-first, auditable by construction, never-delete. Glass is that ethos applied
to **memory itself** — a knowledge base whose every classification decision is
inspectable and reversible, and (with Ollama) one whose intelligence never leaves
your machine.
