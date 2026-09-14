/**
 * Stage 95 checks (pure, static — no network / DB / render):
 *
 *   The payment provider (WayForPay) requires the merchant site to publicly display
 *   legal / informational pages before enabling payments. This stage adds three public,
 *   auth-free pages — Terms & Conditions (/terms), Refund Policy (/refund-policy) and
 *   Contacts / legal details (/contacts) — a reusable footer that links all three, and
 *   a shared merchant-details block, and wires the footer into the public login/signup pages.
 *
 * This test asserts the page/route files exist, carry the required legal content and the
 * exact non-fabricated placeholders, and that the footer links every legal page and is
 * rendered on the public login page (so reviewers reach the pages while logged out).
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage95.ts
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const TERMS = "app/terms/page.tsx";
const REFUND = "app/refund-policy/page.tsx";
const CONTACTS = "app/contacts/page.tsx";
const FOOTER = "components/site-footer.tsx";
const LEGAL = "components/legal-page.tsx";
const LOGIN = "app/login/_components/login-form.tsx";
const MIDDLEWARE = "middleware.ts";

// ── Files exist ──
for (const f of [TERMS, REFUND, CONTACTS, FOOTER, LEGAL, LOGIN, MIDDLEWARE]) {
  ok(existsSync(f), `file exists: ${f}`);
}

const terms = readFileSync(TERMS, "utf8");
const refund = readFileSync(REFUND, "utf8");
const contacts = readFileSync(CONTACTS, "utf8");
const footer = readFileSync(FOOTER, "utf8");
const legal = readFileSync(LEGAL, "utf8");
const login = readFileSync(LOGIN, "utf8");
const middleware = readFileSync(MIDDLEWARE, "utf8");

// Combined text of the legal-facing files (pages inherit the merchant block from legal-page.tsx).
const all = terms + refund + contacts + legal;

// ── Required merchant identity (verbatim) ──
{
  ok(/Moshkivskyi Vitalii/.test(all), "merchant name 'Moshkivskyi Vitalii' present");
  ok(/ФОП/.test(all), "entity keeps its ФОП spelling");
  ok(/Svitla 6/.test(all), "address 'Svitla 6' present");
  ok(/Kharkiv/.test(all), "city 'Kharkiv' present");
  ok(/support@foltum-studio\.com/.test(all), "support email present");
  ok(/WayForPay/.test(all), "WayForPay named as the payment provider");
}

// ── Exact non-fabricated placeholders (must NOT be filled in) ──
{
  ok(all.includes("[IPN / EDRPOU: ____________]"), "exact IPN/EDRPOU placeholder present");
  ok(all.includes("[Phone: +380 __ ___ __ __]"), "exact phone placeholder present");
}

// ── Terms page: service / payment / delivery coverage ──
{
  ok(/payment/i.test(terms), "Terms covers payment");
  ok(/deliver/i.test(terms), "Terms covers delivery of the digital service");
  ok(/Visa|Mastercard/i.test(terms), "Terms lists card payment methods");
  ok(/Apple Pay/i.test(terms) && /Google Pay/i.test(terms), "Terms lists Apple Pay & Google Pay");
  ok(/instant|immediately|real time|real-time/i.test(terms), "Terms states instant electronic delivery");
  ok(/subscription|credits/i.test(terms), "Terms describes subscription/credits");
}

// ── Refund page: refund conditions & procedure ──
{
  ok(/refund/i.test(refund), "Refund page covers refunds");
  ok(/non-refundable|non refundable/i.test(refund), "Refund page states what is non-refundable");
  ok(/procedure|process|request/i.test(refund), "Refund page describes the refund procedure");
  ok(/original payment method/i.test(refund), "Refund page: refund goes to original payment method");
  ok(/WayForPay/.test(refund), "Refund page references WayForPay");
}

// ── Contacts page: full legal details ──
{
  ok(/Moshkivskyi Vitalii/.test(contacts) || /MerchantDetails/.test(contacts), "Contacts shows merchant identity");
  ok(/support@foltum-studio\.com/.test(contacts), "Contacts shows support email");
}

// ── Footer links all three legal pages + merchant name ──
{
  ok(/href="\/terms"/.test(footer), "footer links /terms");
  ok(/href="\/refund-policy"/.test(footer), "footer links /refund-policy");
  ok(/href="\/contacts"/.test(footer), "footer links /contacts");
  ok(/Moshkivskyi Vitalii/.test(footer), "footer shows merchant name");
}

// ── Footer rendered on the public login page ──
{
  ok(/SiteFooter/.test(login), "login page imports & renders SiteFooter");
  ok(/from ['"]@\/components\/site-footer['"]/.test(login), "login imports SiteFooter from components/site-footer");
}

// ── Legal pages are publicly reachable (not behind auth) ──
{
  // Pages must not gate on auth()/redirect the way protected pages do.
  ok(!/auth\(\)/.test(terms) && !/auth\(\)/.test(refund) && !/auth\(\)/.test(contacts), "legal pages do not call auth() (public)");
  // Middleware explicitly whitelists them.
  ok(/"\/terms"/.test(middleware) && /"\/refund-policy"/.test(middleware) && /"\/contacts"/.test(middleware), "middleware whitelists the legal routes as public");
}

console.log(`\nAll ${pass} Stage 95 checks passed.`);
