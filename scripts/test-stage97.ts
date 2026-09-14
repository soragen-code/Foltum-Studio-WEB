/**
 * Stage 97 — two independent fixes:
 *   PART 1: character "appearance" must BEGIN with an explicit sex/gender token and carry
 *           clearly gendered (feminine / masculine) features, so women stop rendering as men.
 *   PART 2: the legal SiteFooter is rendered site-wide from the root layout (once per page),
 *           and the legal routes still exist.
 *
 * Static assertions on NON-protected source text. No protected file is read for content.
 */
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = process.cwd();
const idea = readFileSync(`${root}/lib/idea.ts`, "utf8");
const layout = readFileSync(`${root}/app/layout.tsx`, "utf8");

// ---- PART 1: gender-first appearance directive ----
const cfrMatch = idea.match(/const CHARACTER_FIELD_RULES\s*=\s*`([\s\S]*?)`;/);
ok(cfrMatch, "CHARACTER_FIELD_RULES constant is present in lib/idea.ts");
const cfr = cfrMatch![1];

ok(/begin|start|first/i.test(cfr), "PART 1: appearance rule references BEGIN/START/FIRST position");
ok(
  /(sex|gender|"a woman"|"a man"|a woman|a man|woman\/man)/i.test(cfr),
  "PART 1: appearance must open with an explicit sex/gender token"
);
ok(/feminine/i.test(cfr), "PART 1: rule requires clearly feminine features for women");
ok(/masculine/i.test(cfr), "PART 1: rule requires clearly masculine features for men");
// Extra concept checks
ok(/every tier|MAIN|SUPPORTING|MINOR|CROWD/i.test(cfr), "PART 1: gender lock applies across tiers incl. CROWD");
ok(/never render|wrong sex|drift/i.test(cfr), "PART 1: rule forbids the model drifting to the wrong sex");

// ---- PART 2: SiteFooter rendered site-wide from the root layout ----
ok(/site-footer|SiteFooter/.test(layout), "PART 2: app/layout.tsx references SiteFooter/site-footer");
ok(/import\s*\{\s*SiteFooter\s*\}\s*from\s*['"]@\/components\/site-footer['"]/.test(layout), "PART 2: root layout imports SiteFooter");
ok(/<SiteFooter\s*\/>/.test(layout), "PART 2: root layout renders <SiteFooter />");

// SiteFooter must be rendered exactly ONCE across app/ (only in the root layout)
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
};
walk(`${root}/app`);
const renderCount = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/<SiteFooter\s*\/>/g)?.length ?? 0), 0);
ok(renderCount === 1, `PART 2: <SiteFooter /> is rendered exactly once in app/ (found ${renderCount})`);

// ---- PART 2: legal routes still exist ----
ok(existsSync(`${root}/app/terms/page.tsx`), "PART 2: /terms route exists");
ok(existsSync(`${root}/app/refund-policy/page.tsx`), "PART 2: /refund-policy route exists");
ok(existsSync(`${root}/app/contacts/page.tsx`), "PART 2: /contacts route exists");

console.log(`\nStage 97: ${pass} checks passed.`);
