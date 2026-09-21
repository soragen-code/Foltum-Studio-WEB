/**
 * Admin one-off: zero out the credit balance of EVERY existing account.
 *
 * Part of the switch to a paid-only credit model (1 credit = 1 second of video = $1):
 * all historical free/welcome credits are removed so nobody keeps a legacy balance.
 * For every user that held a non-zero balance we write a CreditTransaction audit row
 * (amount = -(old balance)) so the reset is fully traceable. No users are deleted and
 * no other field is touched — only `credits` is set to 0.
 *
 * Run against the PROD Neon DB (unpooled connection for a direct script):
 *   set -a; source /home/ubuntu/.prod.env; export DATABASE_URL="$DATABASE_URL_UNPOOLED"; set +a
 *   npx tsx --tsconfig tsconfig.json scripts/zero-all-credits.ts
 */
import { prisma } from "@/lib/db";

const RESET_DESCRIPTION = "Admin reset: credits zeroed — paid-only model";

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, credits: true } });
  const totalUsers = users.length;
  const totalBefore = users.reduce((sum, u) => sum + (u.credits ?? 0), 0);
  const nonZero = users.filter((u) => (u.credits ?? 0) !== 0);

  console.log("=== zero-all-credits ===");
  console.log(`Users (total):            ${totalUsers}`);
  console.log(`Users with credits > 0:   ${nonZero.length}`);
  console.log(`Total credit balance BEFORE: ${totalBefore}`);

  if (totalUsers === 0) {
    console.log("No users found — nothing to do.");
    return;
  }

  // Audit trail: one negative CreditTransaction per user that actually loses credits.
  if (nonZero.length > 0) {
    await prisma.creditTransaction.createMany({
      data: nonZero.map((u) => ({
        userId: u.id,
        amount: -(u.credits ?? 0),
        description: RESET_DESCRIPTION,
      })),
    });
    console.log(`Audit records written:    ${nonZero.length}`);
  } else {
    console.log("Audit records written:    0 (every balance was already 0)");
  }

  // Zero every account's balance.
  const updated = await prisma.user.updateMany({ data: { credits: 0 } });
  console.log(`Users updated (credits→0): ${updated.count}`);

  // Verify.
  const after = await prisma.user.findMany({ select: { credits: true } });
  const totalAfter = after.reduce((sum, u) => sum + (u.credits ?? 0), 0);
  const anyNonZero = after.some((u) => (u.credits ?? 0) !== 0);

  console.log(`Total credit balance AFTER:  ${totalAfter}`);
  console.log(`All balances zero:        ${anyNonZero ? "NO — CHECK!" : "YES"}`);
  console.log("=== done ===");
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("zero-all-credits failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
