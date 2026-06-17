// weir — shelf-edge label holder (clip-on, no adhesive)
// Hooks over the front edge of an open melamine shelf; the front plate carries a
// Brother P-touch label (pasted on). Parametric: tune the vars, F5 preview / F6
// render, export STL. PLA-friendly defaults — this is a fit-test v1.
//
// Part of the physical-library tooling arc (see ROADMAP.md → Glass): the printed
// clip + a Brother label, holding a class-section marker that matches the call
// numbers (e.g. "36 · Earth sciences"). Pairs with tools/shelf-list.mjs.
//
// PRINT ORIENTATION: lay it FRONT-FACE-DOWN on the bed (the flat label face on the
// glass = smoothest surface for the tape; the two grip arms then point straight UP,
// so there are no overhangs and you need no supports).
//
// TUNING: if it's too tight/loose on the shelf after the first print, change
// `fit_tolerance` only and reprint — that's the one dimension PLA shrinkage affects.

/* ---------- parameters ---------- */
shelf_thickness = 18;    // melamine board thickness at the front edge (mm)
fit_tolerance   = 0.4;   // slide-on clearance; bump to ~0.6 if the first print is tight
wall            = 2.4;   // structural wall thickness (3 perimeters @ 0.4 nozzle ≈ 1.2; 2.4 is sturdy)
top_lip         = 5;     // how far the UPPER arm reaches onto the shelf top — keep small;
                         //   front-align your spines just behind this little rail
bottom_lip      = 12;    // how far the LOWER arm tucks under the board (longer = hangs steadier)
holder_width    = 75;    // length along the shelf edge (also the max label width)

label_recess    = 0;     // 0 = flat front face (just paste the Brother label on it).
                         //   set e.g. 0.6 for a shallow pocket that registers the tape straight
label_w         = 68;    // recess width  (only used if label_recess > 0)
label_h         = 12;    // recess height (Brother 12 mm tape; use 18 for 18 mm tape)

$fn = 32;

/* ---------- derived ---------- */
gap   = shelf_thickness + fit_tolerance;   // vertical cavity the board slides into
// 2D C-clip cross-section in (X = depth, Y = height); plate at front (X 0..wall),
// arms reach back (negative X) over/under the board.
module profile() {
  polygon([
    [-top_lip,     gap/2        ],   // upper arm — inner, back
    [-top_lip,     gap/2 + wall ],   // upper arm — outer, back
    [ wall,        gap/2 + wall ],   // front plate — top outer
    [ wall,       -gap/2 - wall ],   // front plate — bottom outer
    [-bottom_lip, -gap/2 - wall ],   // lower arm — outer, back
    [-bottom_lip, -gap/2        ],   // lower arm — inner, back
    [ 0,          -gap/2        ],   // cavity — inner bottom front
    [ 0,           gap/2        ],   // cavity — inner top front
  ]);
}

difference() {
  linear_extrude(height = holder_width) profile();   // extrude along the shelf edge
  if (label_recess > 0)                               // optional label-registration pocket
    translate([wall - label_recess, -label_h/2, (holder_width - label_w)/2])
      cube([label_recess + 1, label_h, label_w]);
}
