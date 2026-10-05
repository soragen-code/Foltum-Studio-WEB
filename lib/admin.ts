/**
 * Admin / test account — the single place that decides who is an administrator.
 *
 * The hidden test account (see scripts/seed.ts) is always an admin. Additional admin e-mails can be
 * supplied via the `ADMIN_EMAILS` env variable (comma-separated). Admins:
 *  - bypass every subscription gate (`canUse` in lib/entitlements.ts returns true for them);
 *  - see the «Админ» button in the header and may open /admin (statistics).
 *
 * Keep this module free of server-only imports (no Prisma) — it is also used by auth.ts callbacks.
 */

const SEEDED_TEST_ACCOUNT = "abacus-f264e062@example.com";

function parseEnvList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const ADMIN_EMAILS: ReadonlySet<string> = new Set<string>([
  SEEDED_TEST_ACCOUNT,
  ...parseEnvList(process.env.ADMIN_EMAILS),
]);

/** True when `email` belongs to an administrator / the test account. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}
