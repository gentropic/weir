// @gcu/weir — entry manifest.
//
// build.js inlines each import below, in this order, into weir.html. Modules
// elsewhere may import names from these for dev-time clarity; those imports are
// stripped at build and resolve via this concatenation order. The last module
// (boot) kicks things off on load.
//
// Dev workflow: edit src/, run `node build.js`, open weir.html.

import '../../vendor/vfs.js';   // → VFS, IDBBackend, OPFSBackend, FSAABackend, path, …
import './boot.js';             // boots on DOMContentLoaded
