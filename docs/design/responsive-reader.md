# Responsive reader surface — design

**Status:** drafting. Phase 0 (foundation) shipped 2026-06-24, then generalized into **layout
modes** (Auto/Workspace/Tablet/Reader, a `[data-layout]` resolver + a Settings→Display chooser +
rail gear, device-local) and a **tablet master-detail tier** (list-left / reading-pane-right) —
both shipped 2026-06-24, Playwright-verified (`tools/e2e-layout.mjs`). Phases 1–2 (dedicated reader
shell, capture/share-target) still specced, not built.

## Why now

The roles model + cloud sync (SYNC.md) created real **`reader` devices** — a tablet/phone
that *reads the synced corpus and takes notes*, never polls or curates. But weir's UI is a
keyboard-first, multi-pane **`@gcu/rails` workspace** built for the hub's curation, and it has
**zero `@media` queries** — a fixed desktop layout. So: landscape-tablet survives, tablet-portrait
cramps, and a phone is *useless* (the 240 px source rail eats a ~360 px screen; `.app` is a
`grid-template-columns: var(--rail-w,240px) 1fr`). The viewport meta is already correct
(`build.js`); the gap is purely responsive CSS + a touch-shaped surface.

This **supersedes the old "no mobile" line** (CLAUDE.md / SPEC §"out of scope") for the *reader*
case — SYNC.md already began that reconciliation. Curation stays desktop/hub-only.

## Thesis

Responsive here is **not** "reflow the curation workspace onto a phone" (that fights the
keyboard-first, movable-pane design). It's a **lean, touch-first reader surface that swaps in on
narrow screens**, reusing the same store + item-rendering, and *dropping* the curation machinery
(feed management, router rules, recovery, cataloger, the movable rails workspace).

**Trigger = width breakpoint**, with the `reader` role as a secondary hint — because DeX /
landscape are genuinely fine with the full workspace (you confirmed DeX is fine). So: wide → the
workspace; narrow → the reader. Role only ever *hides curation*, it doesn't force the layout.

## Scope (decided)

Mobile (narrow) surface = **reader + light capture**:

- **Read:** inbox list, open/read an item, save / tag / mark-read, search, read + edit notes.
- **Light capture:** paste a URL → add-feed / save-link, as **decides-vs-proposes proposals the
  hub ratifies** (GLASS §2.1) — capture-on-the-go without granting the phone curation authority.
- **Web Share Target** (PWA): register weir in the OS share sheet so "share → weir" lands a URL
  into the same capture flow. The native complement to the Telegram bot — share target = "weir is
  installed on *this* phone"; TG bot = "from anywhere, no install". GET-based
  (`/?share=1&url=&text=&title=`) so no service-worker POST interception is needed; the launch
  handler routes the params into the capture proposal. (`manifest.webmanifest` gains a
  `share_target` block.)

**Out of mobile scope** (desktop/hub only): feed management, router rules, recovery, cataloger
settings, the movable rails workspace, most of Settings (mobile Settings = sync + role + theme).

## Phases

0. **Foundation — SHIPPED.** A width breakpoint (**`max-width: 1024px`** — covers phones AND tablet
   *portrait*, e.g. Galaxy Tab S10 FE ~720–960 CSS-wide in portrait / ~1152–1536 landscape, so
   portrait→reader, landscape→workspace): `.app` → single column; the
   source rail becomes an **off-canvas drawer** (a `≡` toggle + a scrim, default hidden); the
   stream goes full-width; the resizer is hidden; tap targets enlarged; chrome condensed. Makes
   *reading the inbox + items + save/tag* usable on a phone today, reusing existing components. A
   stopgap the reader layout builds on, not the final UX.
1. **Reader layout.** A dedicated narrow-screen shell: **list → item-detail → note** with
   back-gesture nav and a **bottom bar** (Inbox / Saved / Search / Notes). Touch-tuned item cards
   + reading view; reuses the store + `renderItem`. The rails workspace stays desktop-only.
2. **Capture + Share Target.** In-app quick-add (paste URL) + the `share_target` manifest entry +
   launch handler → the capture proposal flow.
3. **Tablet master-detail — SHIPPED.** Its own `[data-layout="tablet"]` tier: the stream is a
   list on the **left** (~44%), the opened item reads in a pane on the **right** (~56%). Reuses the
   inline-expand mechanic — the expanded row's `.iexpand` is lifted into a fixed right pane (cleared
   from the topbar via `--content-top`); an empty pane shows a "Select an item to read" placeholder.
   The tablet stops being "a big phone." (Driven by the layout-mode resolver; forceable in Settings.)
4. **Later.** Offline-reading polish, note editing ergonomics (below), a richer tablet reading
   toolbar in the pane (back/next, note-alongside).

## Open questions

- **Primary nav on phone:** bottom bar (recommended, thumb-reachable) vs the phase-0 drawer.
- **Note editing on mobile:** the CM6 editor's touch usability is unproven on a phone — may need a
  plain-`textarea` fallback below a width, with CM6 reserved for desktop/tablet.
- **Share-target ↔ TG-bot dedupe:** both can land the same link; the capture flow should dedupe
  by URL (weir already dedups item ids).
- **Reader role on a wide screen (DeX):** lean = width wins (DeX gets the workspace); role only
  hides curation. Revisit if that feels wrong in practice.

## Decisions held

- **Width-triggered, not role-only** — DeX/landscape keep the full workspace.
- **Additive, not a rewrite** — same store + item rendering, a different *shell*; no fork of the
  data/render layer.
- **Share target IN** (native capture) **and** the TG bot stays (universal capture) — different
  entry points, one capture→proposal flow.
- **Curation stays on the hub** — the reader proposes; the hub decides.
