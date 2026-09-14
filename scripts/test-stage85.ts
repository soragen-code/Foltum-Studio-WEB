/**
 * Stage 85 — References page layout: the LOCATION references render FIRST as a distinct,
 * highlighted block at the top, with slightly larger cards; the CHARACTER reference blocks
 * follow below. This is a layout / render-order change only — no generation logic touched.
 *
 * Covered:
 *  (1) the location section is marked to render first (order-first) and is visually highlighted;
 *  (2) the location block carries the "base layer" emphasis (ties to Stage 84);
 *  (3) location cards are larger than character cards (fewer grid columns + taller preview);
 *  (4) no generation logic / handlers were removed; Stage 75/79-84 wiring preserved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL: " + label); process.exit(1); }
  console.log("ok: " + label);
  passed++;
}

const ROOT = join(__dirname, "..");
const refs = readFileSync(join(ROOT, "app/project/[id]/_components/references-stage.tsx"), "utf8");

// Slice out the location section (from its opening <section ...location-references...> to </section>).
const locStart = refs.indexOf('data-testid="location-references"');
ok("0: location section exists", locStart > 0);
const secOpenStart = refs.lastIndexOf("<section", locStart);
const secClose = refs.indexOf("</section>", locStart);
ok("0: location section is well-formed", secOpenStart >= 0 && secClose > locStart);
const locSection = refs.slice(secOpenStart, secClose);

// ---- (1) location renders first + highlighted -------------------------------
ok("1: outer container is a flex column (enables order-first reorder)", /className="flex flex-col gap-6"/.test(refs));
ok("1: location section is order-first (renders before character blocks)", /order-first/.test(locSection));
ok("1: location section is visually highlighted (accent border + tint)", /border-primary\/40/.test(locSection) && /bg-primary\/5/.test(locSection));

// ---- (2) base-layer emphasis (ties to Stage 84) -----------------------------
ok("2: location block shows the base-layer emphasis badge", /Базовый слой сцены/.test(locSection));
ok("2: location heading + MapPin retained", /Референсы локаций/.test(locSection) && /MapPin/.test(locSection));

// ---- (3) location cards larger than character cards -------------------------
// Character groups grid uses lg:grid-cols-3; the location grid must use fewer columns → wider cards.
ok("3: character grid still lg:grid-cols-3", /<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">/.test(refs));
ok("3: location grid uses lg:grid-cols-2 (wider → larger cards)", /mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-2/.test(locSection));
ok("3: location preview is taller than before (max-h-80)", /max-h-80/.test(locSection));
ok("3: old smaller location preview height removed", !/aspect-\[9\/16\] max-h-64/.test(locSection));

// ---- (4) generation logic preserved ----------------------------------------
ok("4: character reference generation buttons intact", /data-testid="references-start"/.test(refs) && /startReferences/.test(refs));
ok("4: bulk tier generation intact", /data-testid="references-start-all"/.test(refs) && /startBulk/.test(refs));
ok("4: location generate / revise / undo handlers intact", /generateLocation/.test(refs) && /reviseLocation/.test(refs) && /undoLocation/.test(refs));
ok("4: per-shot regenerate intact", /regenShot/.test(refs) && /data-testid="location-generate"/.test(refs));
ok("4: extra-angles generation intact", /generateExtraLocation/.test(refs) && /data-testid="location-extra-generate"/.test(refs));
ok("4: character user-refs (Stage 75) intact", /CharacterUserRefs/.test(refs));
ok("4: continue-to-script intact", /data-testid="continue-to-script"/.test(refs) && /continueToScript/.test(refs));
ok("4: provider picker intact", /ProviderPicker/.test(refs));

// ---- render-order sanity: location section physically before OR order-first --
// With flex + order-first the DOM position may remain later in source, but the CSS forces it first.
ok("5: reorder achieved via order-first utility (layout-only, no JSX move needed)", /order-first[^"]*rounded-xl border-2 border-primary\/40/.test(locSection) || /order-first/.test(locSection));

console.log(`\nAll ${passed} Stage 85 checks passed.`);
