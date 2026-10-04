/**
 * Admin one-off: credit redenomination ×10.
 *
 * All prices in credits were multiplied by 10 (10 credits = 1 second of video) and every credit pack
 * now grants 10× more credits for the same USD price. To keep existing balances worth exactly the same,
 * every user's `credits` is multiplied by 10 in ONE SQL statement; for every non-zero balance a
 * CreditTransaction audit row (+9 × old balance) is written. Idempotent via the audit description:
 * if any row with REDENOM_DESCRIPTION already exists, the script refuses to run again.
 *
 * Run against the PROD DB:
 *   set -a; source /home/ubuntu/.prod.env; export DATABASE_URL="$DATABASE_URL_UNPOOLED"; set +a
 *   npx tsx --tsconfig tsconfig.json scripts/redenominate-credits-x10.ts
 */
import { prisma } from "@/lib/db";

const FACTOR = 10;
const REDENOM_DESCRIPTION = "Admin redenomination: credits ×10 (10 credits = 1 second)";

async function main() {
  const already = await prisma.creditTransaction.findFirst({ where: { description: REDENOM_DESCRIPTION }, select: { id: true } });
  if (already) {
    console.log("Redenomination already applied — refusing to run twice.");
    return;
  }
  const users = await prisma.user.findMany({ select: { id: true, credits: true } });
  const nonZero = users.filter((u) => (u.credits ?? 0) !== 0);
  const totalBefore = users.reduce((s, u) => s + (u.credits ?? 0), 0);
  console.log(`Users: ${users.length}, with non-zero balance: ${nonZero.length}, total BEFORE: ${totalBefore}`);

  await prisma.$transaction([
    prisma.$executeRaw`UPDATE "User" SET "credits" = "credits" * ${FACTOR} WHERE "credits" <> 0`,
    prisma.creditTransaction.createMany({
      data: nonZero.map((u) => ({ userId: u.id, amount: (u.credits ?? 0) * (FACTOR - 1), description: REDENOM_DESCRIPTION })),
    }),
  ]);

  const after = await prisma.user.aggregate({ _sum: { credits: true } });
  console.log(`Total AFTER: ${after._sum.credits ?? 0} (expected ${totalBefore * FACTOR})`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
