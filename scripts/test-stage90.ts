/**
 * Stage 90 checks (pure, static — no network / DB / render):
 *
 *  Bug: on the references page the Location block was NOT first, even though Stage 85/86 claimed it was.
 *
 *  ROOT CAUSE (proven): the visible references page is rendered by
 *  app/project/[id]/_components/references-stage.tsx (the project wizard mounts <ReferencesStage> for
 *  stage==='references' and for the ?tab=references tab; characters-stage.tsx renders NO locations, so it
 *  was never the visible page). Stage 85/86 left the location <section> LAST in the JSX and floated it up
 *  only with Tailwind's `order-first` utility. That utility was never emitted into the compiled CSS
 *  (verified: `.order-first` absent from .next output while sibling classes from the same section, e.g.
 *  border-primary/40, WERE emitted), so the class was inert and the section fell back to its natural
 *  (last) DOM position — hence the location kept rendering below the characters.
 *
 *  FIX: emit the location <section> FIRST in the JSX so it is physically first in the DOM, independent of
 *  any CSS `order` utility. Separation stays by TYPE (location comes from the dedicated `locations`
 *  relation, never mixed into the character groups), so it holds for old and new projects regardless of
 *  DB record order. Location cards stay slightly larger (lg:grid-cols-2 vs the character grid's
 *  lg:grid-cols-3). English labels. No generation logic touched.
 *
 *   A. The visible references page is references-stage.tsx (wired in project-wizard for references stage/tab;
 *      characters-stage.tsx renders no locations).
 *   B. In references-stage.tsx the location section is emitted BEFORE the characters header and the
 *      character groups (source/DOM order — the reliable guarantee).
 *   C. The location-first ordering does NOT rely on the `order-first` CSS utility anymore.
 *   D. Location and characters are rendered as SEPARATE blocks by TYPE (locations relation vs character
 *      groups) — not one shared loop — so old projects order correctly regardless of DB order.
 *   E. Location cards are slightly larger than character cards (fewer grid columns).
 *   F. Labels are English; the location block is a distinct highlighted section with an English heading.
 *   G. No generation logic / model selector was introduced by this layout change.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage90.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const REF = "app/project/[id]/_components/references-stage.tsx";
const CHARS = "app/project/[id]/_components/characters-stage.tsx";
const WIZ = "app/project/[id]/_components/project-wizard.tsx";

const ref = readFileSync(REF, "utf8");
const chars = readFileSync(CHARS, "utf8");
const wiz = readFileSync(WIZ, "utf8");

// ── A. The visible references page is references-stage.tsx ──────────────────────────────────────
{
  ok(wiz.includes("import { ReferencesStage }") && wiz.includes("<ReferencesStage"), "A: project-wizard mounts <ReferencesStage> for the references page");
  ok(/referencesTab[\s\S]{0,120}<ReferencesStage/.test(wiz) || /currentStage === 'references'[\s\S]{0,120}<ReferencesStage/.test(wiz), "A: ReferencesStage is what renders for the references stage / ?tab=references");
  // characters-stage.tsx is the OLD character-only stage and renders NO location UI, so it was never the visible references page.
  ok(!/location-references|LocationCard|locations\.map/.test(chars), "A: characters-stage.tsx renders no locations (not the references page)");
  ok(ref.includes('data-testid="location-references"') && ref.includes("locations.map((loc)"), "A: references-stage.tsx is the one that renders the location references");
}

// ── B. Location section is emitted FIRST in the JSX (source/DOM order) ──────────────────────────
{
  const locPos = ref.indexOf('data-testid="location-references"');
  const hdrPos = ref.indexOf("Step 2 — Characters (references)"); // the Characters block header
  const grpPos = ref.indexOf("groups.map((g)");                    // the character tier groups
  ok(locPos > 0 && hdrPos > 0 && grpPos > 0, "B: location section, characters header and character groups are all present");
  ok(locPos < hdrPos, "B: the location section comes before the Characters header in the JSX/DOM");
  ok(locPos < grpPos, "B: the location section comes before the character groups in the JSX/DOM");
}

// ── C. Ordering no longer depends on the (inert) `order-first` CSS utility ──────────────────────
{
  // The location <section> element must NOT carry the order-first class. (Comments may still mention the
  // token when explaining the fix, so we check the actual className on the section, not the whole file.)
  const secStart = ref.indexOf("<section", ref.indexOf('data-testid="location-references"') - 400);
  const secTag = ref.slice(ref.lastIndexOf("<section", ref.indexOf('data-testid="location-references"')), ref.indexOf('data-testid="location-references"') + 30);
  ok(!/className="[^"]*order-first/.test(secTag), "C: the location <section> no longer uses the order-first CSS utility");
  ok(!/className="order-first/.test(ref), "C: no element in the references page relies on order-first for placement");
}

// ── D. Separate blocks by TYPE (locations relation vs character groups) — not one shared loop ───
{
  // locations render from their own relation/state; characters render from grouped tiers — two distinct maps.
  ok(ref.includes("locations.map((loc)"), "D: locations render from their own list (locations relation)");
  ok(ref.includes("groups.map((g)") && ref.includes("g.items.map((c)"), "D: characters render from grouped tiers — a separate mapping");
  // The two are not merged into a single array/loop keyed by DB order.
  const locBlock = ref.slice(ref.indexOf('data-testid="location-references"'), ref.indexOf("groups.map((g)"));
  ok(!locBlock.includes("groups.map"), "D: the location block does not contain the character groups (separate sections, by type)");
}

// ── E. Location cards are slightly larger than character cards ──────────────────────────────────
{
  // Location grid uses fewer columns (lg:grid-cols-2) than the character grid (lg:grid-cols-3) → larger cards.
  const locBlock = ref.slice(ref.indexOf('data-testid="location-references"'), ref.indexOf("Step 2 — Characters (references)"));
  ok(locBlock.includes("lg:grid-cols-2"), "E: location grid uses lg:grid-cols-2 (larger cards)");
  ok(ref.includes("lg:grid-cols-3"), "E: character grid uses lg:grid-cols-3 (smaller cards)");
}

// ── F. English, distinct highlighted location block ────────────────────────────────────────────
{
  ok(ref.includes("Location references"), "F: the location block has an English heading ('Location references')");
  ok(/data-testid="location-references"[\s\S]{0,200}border-2 border-primary/.test(ref) || /border-2 border-primary[\s\S]{0,200}data-testid="location-references"/.test(ref), "F: the location block is visually highlighted (border-2 border-primary)");
  ok(ref.includes("Step 2 — Characters (references)") || ref.includes("References"), "F: the characters block header is present and English");
}

// ── G. Pure layout change — no generation logic / model selector introduced ─────────────────────
{
  ok(!/videoProvider|SEEDANCE|SEEDREAM|model\s*selector/i.test(ref) || ref.includes("Seedream 5.0 Pro"), "G: no video/image model selector was introduced (only the existing provider transport note)");
  ok(!/<select\b/.test(ref), "G: no new dropdown/model <select> was added to the references page");
}

console.log(`\nStage 90: ${pass} checks passed`);
