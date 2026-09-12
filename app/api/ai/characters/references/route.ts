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
import { normalizeImageModel } from "@/lib/ai-models";

/**
 * Stage 53: a character reference is a SINGLE photo — the full-body front shot (imageFull). A character
 * needs generation when it has no anchor at all; legacy characters that still have the old front portrait
 * (imageFront) already count as done (video falls back to imageFront). Profiles/extras are never
 * auto-generated any more, so there is no free extra-only top-up pass.
 */
const missingBase = (c: { imageFront: string | null; imageFull: string | null }) =>
  !c.imageFull && !c.imageFront;

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
    const { projectId, tiers, characterIds, imageModel } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, include: { characters: { orderBy: { createdAt: "asc" } } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    await failStaleJobs({ projectId, type: "characters" });
    const active = await prisma.generationJob.findFirst({ where: { projectId, type: "characters", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true, count: 0 });

    // Stage 53: a character reference is a single photo (imageFull). Generate for every character that
    // has no anchor yet; each is charged one CHARACTER_REFERENCE_COST. The job is idempotent (a character
    // that already has imageFull is skipped), so a resumed run only fills the gaps.
    const scope = project.characters.filter((c) =>
      (!tiers || tiers.includes(c.tier as any)) &&
      (!characterIds || characterIds.includes(c.id))
    );
    const needBase = scope.filter(missingBase);
    const jobCharacterIds = needBase.map((c) => c.id);
    if (jobCharacterIds.length === 0) return NextResponse.json({ jobId: null, count: 0 });

    const cost = needBase.length * CHARACTER_REFERENCE_COST;
    if ((user.credits ?? 0) < cost)
      return NextResponse.json({ error: `Недостаточно кредитов: нужно ${cost} (${needBase.length} × ${CHARACTER_REFERENCE_COST}), на балансе ${user.credits ?? 0}` }, { status: 402 });

    if (cost > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
      await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Референсы персонажей: ${needBase.length} шт.` } });
    }
    await prisma.character.updateMany({ where: { id: { in: jobCharacterIds }, status: "draft" }, data: { status: "approved" } });

    const job = await prisma.generationJob.create({
      data: { type: "characters", status: "processing", progress: 5, message: `Генерация референсов для ${jobCharacterIds.length} персонажей…`, projectId },
    });
    runInBackground(async () => {
      await runCharacterImagesJob({ jobId: job.id, projectId, characterIds: jobCharacterIds, imageModel: normalizeImageModel(imageModel) });
      try {
        // Refund the CHARGED characters whose full-body photo never landed (Stage 53: imageFull is the
        // single generated shot; keep imageFront in the fallback so a legacy resume isn't refunded).
        const after = await prisma.character.findMany({ where: { id: { in: needBase.map((c) => c.id) } }, select: { id: true, name: true, imageFront: true, imageFull: true } });
        const none = after.filter((c) => !c.imageFull && !c.imageFront);
        if (none.length) {
          const refund = none.length * CHARACTER_REFERENCE_COST;
          await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
          await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Возврат: референсы не сгенерированы (${none.map((c) => c.name).join(", ")})` } });
        }
      } catch (e) { console.error("[characters/references] refund check failed:", e); }
    });
    return NextResponse.json({ jobId: job.id, count: jobCharacterIds.length, cost, creditsRemaining: (user.credits ?? 0) - cost });
  } catch (err: any) {
    console.error("Characters references error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
