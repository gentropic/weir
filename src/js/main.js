// @gcu/weir — entry manifest.
//
// build.js inlines each import below, in this order, into weir.html. Modules
// elsewhere may import names from these for dev-time clarity; those imports are
// stripped at build and resolve via this concatenation order. The last module
// (boot) kicks things off on load.
//
// Dev workflow: edit src/, run `node build.js`, open weir.html.

import '../../vendor/vfs.js';            // → VFS, IDBBackend, OPFSBackend, FSAABackend, path, …
import '../../vendor/bridge-client.js';  // → gcuFetch, hasBridge, bridgeVersion, clearBridgeCache
import './store/schema.js';              // data model + helpers (before store)
import './store/store.js';               // → Store (uses VFS + schema globals)
import './parse/xml.js';                 // → parseXml (before feed)
import './parse/sanitize.js';            // → sanitizeHtml (before feed)
import './adapters/feed.js';             // → parseFeed, feedAdapter (uses xml/sanitize/schema)
import './boot.js';                      // boots on DOMContentLoaded
