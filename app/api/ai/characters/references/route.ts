export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, charactersReferencesSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";

/**
 * POST /api/ai/characters/references  { projectId, tiers?: [...], characterIds?: [...] }
 * Bulk reference generation for characters that still have no images
 * («Сгенерировать все главные / второстепенные / всех»). Charges CHARACTER_REFERENCE_COST
 * per character; one "characters" job for the batch (idempotent while a job is active).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:characters-references", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, charactersReferencesSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, tiers, characterIds } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, include: { characters: { orderBy: { createdAt: "asc" } } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    await failStaleJobs({ projectId, type: "characters" });
    const active = await prisma.generationJob.findFirst({ where: { projectId, type: "characters", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true, count: 0 });

    const pending = project.characters.filter((c) =>
      (!c.imageFront || !c.imageProfile || !c.imageFull) &&
      (!tiers || tiers.includes(c.tier as any)) &&
      (!characterIds || characterIds.includes(c.id))
    );
    if (pending.length === 0) return NextResponse.json({ jobId: null, count: 0 });

    const cost = pending.length * CHARACTER_REFERENCE_COST;
    if ((user.credits ?? 0) < cost)
      return NextResponse.json({ error: `Недостаточно кредитов: нужно ${cost} (${pending.length} × ${CHARACTER_REFERENCE_COST}), на балансе ${user.credits ?? 0}` }, { status: 402 });

    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Референсы персонажей: ${pending.length} шт.` } });
    await prisma.character.updateMany({ where: { id: { in: pending.map((c) => c.id) }, status: "draft" }, data: { status: "approved" } });

    const job = await prisma.generationJob.create({
      data: { type: "characters", status: "processing", progress: 5, message: `Генерация референсов для ${pending.length} персонажей…`, projectId },
    });
    runInBackground(async () => {
      await runCharacterImagesJob({ jobId: job.id, projectId, characterIds: pending.map((c) => c.id) });
      try {
        // Refund the characters that got nothing at all.
        const after = await prisma.character.findMany({ where: { id: { in: pending.map((c) => c.id) } }, select: { id: true, name: true, imageFront: true, imageProfile: true, imageFull: true } });
        const none = after.filter((c) => !c.imageFront && !c.imageProfile && !c.imageFull);
        if (none.length) {
          const refund = none.length * CHARACTER_REFERENCE_COST;
          await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
          await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Возврат: референсы не сгенерированы (${none.map((c) => c.name).join(", ")})` } });
        }
      } catch (e) { console.error("[characters/references] refund check failed:", e); }
    });
    return NextResponse.json({ jobId: job.id, count: pending.length, cost, creditsRemaining: (user.credits ?? 0) - cost });
  } catch (err: any) {
    console.error("Characters references error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
