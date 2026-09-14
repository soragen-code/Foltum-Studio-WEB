/**
 * Stage 85 — References page layout: the LOCATION references render FIRST as a distinct,
 * highlighted block at the top, with slightly larger cards; the CHARACTER reference blocks
 * follow below. This is a layout / render-order change only — no generation logic touched.
 *
 * Covered:
 *  (1) the location section renders first (guaranteed by source/DOM order — Stage 90) and is highlighted;
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
// Stage 90: the "location first" intent is preserved but the mechanism changed — it is now guaranteed by
// SOURCE ORDER (the location <section> is emitted first in the JSX) rather than the CSS `order-first`
// utility, which was never emitted into the compiled CSS and therefore never actually reordered anything.
ok("1: outer container is a flex column", /className="flex flex-col gap-6"/.test(refs));
ok("1: location section renders before the character blocks (source/DOM order)", refs.indexOf('data-testid="location-references"') < refs.indexOf("groups.map((g)"));
ok("1: location section is visually highlighted (accent border + tint)", /border-primary\/40/.test(locSection) && /bg-primary\/5/.test(locSection));

// ---- (2) base-layer emphasis (ties to Stage 84) -----------------------------
ok("2: location block shows the base-layer emphasis badge", /Base scene layer/.test(locSection));
ok("2: location heading + MapPin retained", /Location references/.test(locSection) && /MapPin/.test(locSection));

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

// ---- render-order sanity: location section physically first in the JSX/DOM --
// Stage 90: order is guaranteed by source order (location emitted first), NOT by the inert `order-first`
// CSS utility. Layout-only; the section is physically before the character header and groups.
ok("5: location section is physically first (before the characters header and groups)",
  refs.indexOf('data-testid="location-references"') < refs.indexOf("Step 2 — Characters (references)") &&
  refs.indexOf('data-testid="location-references"') < refs.indexOf("groups.map((g)"));

console.log(`\nAll ${passed} Stage 85 checks passed.`);
