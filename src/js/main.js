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
import './store/schema.js';              // data model + helpers (before store)
import './affinity.js';                  // → channelIdOf, affinityScore (before store)
import './store/store.js';               // → Store (uses VFS + schema globals)
import './parse/xml.js';                 // → parseXml (before feed)
import './parse/sanitize.js';            // → sanitizeHtml (before feed)
import './adapters/feed.js';             // → parseFeed, feedAdapter (uses xml/sanitize/schema)
import './adapters/youtube.js';          // → parseYoutube, youtubeAdapter (uses parseXml)
import './extract.js';                   // → extractArticle (readability; browser DOMParser)
import './opml.js';                      // → parseOpml, buildOpml (uses parseXml)
import './router.js';                    // → Router, compileRules, DEFAULT_ROUTING
import './wayback.js';                    // → cdxSnapshots, recoverFeed (uses parseFeed at call time)
import './recovery.js';                   // → RecoveryDrip (uses cdxSnapshots)
import './retainer.js';                   // → Retainer (archive-on-expiry; never deletes)
import './pwa.js';                        // → initPwa (service worker + update toast)
import './favicon.js';                    // → FaviconFetcher, monogram (before app)
import './ui/format.js';                 // → relativeTime, sparkPoints, … (before app)
import './ui/menu.js';                    // → showMenu (context menus)
import './poller.js';                    // → Poller
import './ui/app.js';                    // → App (uses format)
import './boot.js';                      // boots on DOMContentLoaded
