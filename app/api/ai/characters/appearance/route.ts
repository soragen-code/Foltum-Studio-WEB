export const dynamic = "force-dynamic";
export const maxDuration = 800; // background reference regeneration runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, characterReviseSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";
import { reviseAppearanceSystemPrompt, reviseAppearanceUserPrompt } from "@/lib/idea";
import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/**
 * POST /api/ai/characters/appearance  { characterId, instruction }
 *
 * "Изменить внешность" on the references step:
 * 1. LLM rewrites the English appearance prompt per instruction
 * 2. Charges CHARACTER_REFERENCE_COST credits (refunded if every image fails)
 * 3. Starts the existing character-images job for THIS character only
 * Idempotent: an active job for the same character is returned instead of a new one.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:character-appearance", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, characterReviseSchema);
    if (!parsed.ok) return parsed.response;
    const { characterId, instruction } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const character = await prisma.character.findFirst({
      where: { id: characterId, project: { userId: user.id } },
      include: { project: true },
    });
    if (!character) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    const projectId = character.projectId;

    // Idempotent start: reuse an active regeneration job for this character.
    await failStaleJobs({ projectId, type: "characters" });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: "characters", characterId, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, character, resumed: true });

    if ((user.credits ?? 0) < CHARACTER_REFERENCE_COST)
      return NextResponse.json(
        { error: `Not enough credits. Need ${CHARACTER_REFERENCE_COST}, have ${user.credits ?? 0}` },
        { status: 402 }
      );

    // 1. New appearance (text)
    let appearance = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !appearance; attempt++) {
      try {
        const raw = await chatJSON<{ appearance?: string }>(
          reviseAppearanceSystemPrompt(),
          reviseAppearanceUserPrompt({ name: character.name, appearance: character.appearance ?? "" }, instruction),
          { temperature: 0.6, maxTokens: 600 }
        );
        const text = String(raw?.appearance ?? "").trim();
        if (text.length < 20) throw new Error("appearance too short");
        appearance = sanitizeVideoPrompt(text, { keep: [character.name] }).prompt.trim() || text;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[characters/appearance] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!appearance) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    // 2. Charge credits (like a reference generation)
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: CHARACTER_REFERENCE_COST } } });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -CHARACTER_REFERENCE_COST,
        description: `Reference regeneration for character ${character.name}`,
      },
    });

    // Stage 22: clear the stored reference shots BEFORE regeneration so that
    // (a) the idempotent character worker regenerates all 3 shots (front → profile/full),
    // (b) the frontend's completeness check flips to false → reference polling resumes and
    //     the spinner holds until the new photos land.
    // Stage 46B-1: no lock concept any more — the character stays editable; scenes always render the current look.
    const updated = await prisma.character.update({
      where: { id: characterId },
      data: {
        appearance,
        status: "approved",
        imageFront: null,
        imageProfile: null,
        imageFull: null,
        imageExtra: null,
      },
    });

    // Stage 46B-1: every rendered scene of the project that shows this character now carries a stale look.
    await prisma.scene.updateMany({
      where: { characters: { some: { characterId } }, videoUrl: { not: null } },
      data: { lookStale: true },
    }).catch(() => {});

    // 3. Background regeneration of the 3 reference shots for this character only
    const job = await prisma.generationJob.create({
      data: {
        type: "characters",
        status: "processing",
        progress: 5,
        message: `Regenerating references for ${character.name}...`,
        projectId,
        characterId,
      },
    });

    runInBackground(async () => {
      await runCharacterImagesJob({ jobId: job.id, projectId, characterIds: [characterId] });
      // Refund when nothing was produced at all.
      try {
        const done = await prisma.generationJob.findUnique({ where: { id: job.id } });
        const rd = (done?.resultData ?? null) as { total?: number; failed?: number } | null;
        const allFailed = done?.status === "failed" || (rd && rd.total && rd.failed === rd.total);
        if (allFailed) {
          await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: CHARACTER_REFERENCE_COST } } });
          await prisma.creditTransaction.create({
            data: { userId: user.id, amount: CHARACTER_REFERENCE_COST, description: `Refund: reference regeneration failed for ${character.name}` },
          });
        }
      } catch (e) {
        console.error("[characters/appearance] refund check failed:", e);
      }
    });

    return NextResponse.json({
      jobId: job.id,
      character: updated,
      creditsRemaining: (user.credits ?? 0) - CHARACTER_REFERENCE_COST,
    });
  } catch (err: any) {
    console.error("Appearance update error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
