// @gcu/weir — entry manifest.
//
// build.js inlines each import below, in this order, into index.html. Modules
// elsewhere may import names from these for dev-time clarity; those imports are
// stripped at build and resolve via this concatenation order. The last module
// (boot) kicks things off on load.
//
// Dev workflow: edit src/, run `node build.js`, open index.html.

import '../../vendor/vfs.js';            // → VFS, IDBBackend, OPFSBackend, FSAABackend, path, …
import '../../vendor/bridge-client.js';  // → gcuFetch, hasBridge, bridgeVersion, clearBridgeCache
import '../../vendor/webmcp-shim.js';    // → window.gcuWebMCP + navigator.modelContext polyfill (IIFE)
import '../../vendor/librarian.js';      // → Librarian (BM25F/CSR search engine; before search.js)
import '../../vendor/yaml.js';           // → parse, emit, scalar/mapNode/seqNode (@gcu/yaml strict subset; for stacks frontmatter)
import '../../vendor/cm6.min.js';        // → window.CM6 (CodeMirror 6 IIFE bundle; the stacks note editor)
import './store/schema.js';              // data model + helpers (before store)
import './affinity.js';                  // → channelIdOf, affinityScore (before store)
import './glass.js';                     // → buildCard, nextGlassId (glass catalog; before store)
import './callnumber.js';                // → callNumber, renderCoded/Readable, sortKey (glass shelf address)
import './biblio.js';                    // → detectBiblio, fetchBiblio (authoritative paper/book metadata; before cataloger; uses decodeEntities from xml.js)
import './llm.js';                       // → chat, PROVIDERS, inputMultiplier (before store + cataloger)
import './cataloger.js';                 // → catalogStoreItem (glass cataloger service; uses llm + glass)
import './llmkeys.js';                   // → getKey/saveKey (OPFS LLM key vault, browser-only)
import './store/store.js';               // → Store (uses VFS + schema globals)
import './stacks.js';                    // → StacksStore (notes/files vault; uses store + yaml)
import './search.js';                    // → SearchIndex (full-text v2 on Librarian; uses store + Librarian)
import './parse/xml.js';                 // → parseXml (before feed)
import './parse/sanitize.js';            // → sanitizeHtml (before feed)
import './ui/markdown.js';               // → renderMarkdown (stacks notes; uses sanitizeHtml)
import './adapters/feed.js';             // → parseFeed, feedAdapter (uses xml/sanitize/schema)
import './adapters/youtube.js';          // → parseYoutube, youtubeAdapter (uses parseXml)
import './adapters/github.js';           // → parseGithub, githubAdapter (releases/commits/tags)
import './extract.js';                   // → extractArticle (readability; browser DOMParser)
import './opml.js';                      // → parseOpml, buildOpml (uses parseXml)
import './importers.js';                 // → detectImport, parseTelegramExport (multi-format link import)
import './runner.js';                     // → BackgroundRunner (one keep-alive path for all background loops)
import './linkresolver.js';              // → LinkResolver (background drip resolving wrapped saved links)
import './telegram.js';                  // → TelegramInflux (live getUpdates capture; reuses importers.messageLinks)
import './router.js';                    // → Router, compileRules, DEFAULT_ROUTING
import './wayback.js';                    // → cdxSnapshots, recoverFeed (uses parseFeed at call time)
import './recovery.js';                   // → RecoveryDrip (uses cdxSnapshots)
import './retainer.js';                   // → Retainer (archive-on-expiry; never deletes)
import './pwa.js';                        // → initPwa (service worker + update toast)
import './fsmount.js';                    // → FSA folder mount (loadHandle, pickDirectory, …)
import './favicon.js';                    // → FaviconFetcher, monogram (before app)
import './health.js';                     // → assessFeed (feed hijack/drift/stale, before app)
import './ui/format.js';                 // → relativeTime, sparkPoints, … (before app)
import './ui/menu.js';                    // → showMenu (context menus)
import './ui/palette.js';                 // → showPalette, filterActions (command palette, Cmd-K)
import './poller.js';                    // → Poller
import './ui/app.js';                    // → App (uses format)
import './webmcp.js';                    // → buildWeirTools, initWebmcp (WebMCP adapter; after app)
import './boot.js';                      // boots on DOMContentLoaded
