export const dynamic = "force-dynamic";
export const maxDuration = 800; // the single-shot regeneration runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, characterShotSchema } from "@/lib/validations";
import { normalizeImageModel } from "@/lib/ai-models";
import { runInBackground, completeJob, failJob } from "@/lib/jobs";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { generateFullBodyWithGuard } from "@/lib/workers/character-images-job";
import { VISUAL_STYLE_ID, isChildAppearance, type CharacterRefKind } from "@/lib/visual-style";
// Stage 46D: full-length frames (shot=full, full-body extras) carry the proportion rule; close-ups do not.
import { characterShotPrompt, characterExtraShotPrompt } from "@/lib/full-body-prompt";
import { parseImageArray } from "@/lib/reference-counts";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";

/** Job type of a single-shot regeneration — distinct from "characters" so the full-set polling ignores it. */
export const CHARACTER_SHOT_JOB_TYPE = "character_shot";

const ASPECT: Record<"front" | "profile" | "full", string> = { front: "3:4", profile: "3:4", full: "9:16" };
const FIELD: Record<"front" | "profile" | "full", "imageFront" | "imageProfile" | "imageFull"> = {
  front: "imageFront",
  profile: "imageProfile",
  full: "imageFull",
};

/**
 * POST /api/ai/characters/[id]/shot  { shot: "front"|"profile"|"full"|"extra", index?, imageModel? }
 *
 * Stage 46B-2: «Перегенерировать» on ONE reference photo. Charges one frame (CHARACTER_REFERENCE_COST),
 * regenerates only that shot from the CURRENT appearance with the same chaining as the full worker
 * (front ← full anchor, profile ← front, full = guarded text-to-image, extra ← front/full by parity),
 * writes only that column and marks rendered scenes with this character as lookStale.
 * Returns { jobId } — the UI polls /api/jobs/[id] and refreshes the references when done.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:character-shot", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id: characterId } = await params;
    const parsed = await parseBody(request, characterShotSchema);
    if (!parsed.ok) return parsed.response;
    const { shot, index } = parsed.data;
    const imageModel = normalizeImageModel(parsed.data.imageModel);
    if (shot === "extra" && index === undefined) return NextResponse.json({ error: "index is required for extra shots" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const char = await prisma.character.findFirst({ where: { id: characterId, project: { userId: user.id } } });
    if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    const projectId = char.projectId;

    const extras = parseImageArray(char.imageExtra);
    if (shot === "extra" && (index! >= extras.length)) return NextResponse.json({ error: "Extra shot not found" }, { status: 404 });

    // One regeneration at a time per photo slot.
    const slotKey = shot === "extra" ? `extra-${index}` : shot;
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: CHARACTER_SHOT_JOB_TYPE, characterId, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      let rd: { slot?: string } = {};
      try { rd = active.resultData ? JSON.parse(active.resultData) : {}; } catch { rd = {}; }
      if (rd.slot === slotKey) return NextResponse.json({ jobId: active.id, resumed: true });
    }

    if ((user.credits ?? 0) < CHARACTER_REFERENCE_COST)
      return NextResponse.json({ error: `Not enough credits. Need ${CHARACTER_REFERENCE_COST}, have ${user.credits ?? 0}` }, { status: 402 });

    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: CHARACTER_REFERENCE_COST } } });
    await prisma.creditTransaction.create({
      data: { userId: user.id, amount: -CHARACTER_REFERENCE_COST, description: `Reference shot regeneration: ${char.name}/${slotKey}` },
    });

    const job = await prisma.generationJob.create({
      data: {
        type: CHARACTER_SHOT_JOB_TYPE,
        status: "processing",
        progress: 10,
        message: `Перегенерация фото «${char.name}» (${slotKey})...`,
        projectId,
        characterId,
        resultData: JSON.stringify({ slot: slotKey }),
      },
    });

    const refund = async (reason: string) => {
      try {
        await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: CHARACTER_REFERENCE_COST } } });
        await prisma.creditTransaction.create({
          data: { userId: user.id, amount: CHARACTER_REFERENCE_COST, description: `Refund: shot regeneration failed for ${char.name}/${slotKey}` },
        });
      } catch (e) {
        console.error("[characters/shot] refund failed:", reason, e);
      }
    };

    runInBackground(async () => {
      try {
        const appearance = char.appearance ?? "";
        const front = char.imageFront;
        const full = char.imageFull;
        const ctx = { jobId: job.id, characterId, imageModel };
        let remote: string;
        let s3Key: string;
        if (shot === "extra") {
          // Same parity rule as the worker: odd = full-body back (full anchor), even = right profile (face).
          const isFullShot = index! % 2 === 1;
          const ref = isFullShot ? (full ?? front) : (front ?? full);
          if (!ref) throw new Error("No base photo to chain the extra angle on");
          const refKind: CharacterRefKind = ref === full && full ? "full" : "face";
          remote = await generateImage(
            { prompt: characterExtraShotPrompt(appearance, char.name, index!, refKind), aspect_ratio: isFullShot ? "9:16" : "3:4", image_input: [ref] },
            ctx
          );
          s3Key = `media/public/characters/${projectId}/${char.id}/${VISUAL_STYLE_ID}/extra-${Date.now()}-${index}.png`;
        } else {
          // Chaining exactly like the full worker: front on the full anchor, profile on the front (fallback full),
          // full-body text-to-image with the proportion guard (legacy: chained on the front).
          let ref: string | null = null;
          let refKind: CharacterRefKind = "face";
          if (shot === "front") { ref = full ?? null; refKind = "full"; }
          else if (shot === "profile") { ref = front ?? full ?? null; refKind = front ? "face" : "full"; }
          else if (shot === "full") { ref = front ?? null; refKind = "face"; }
          const chained = !!ref;
          const basePrompt = characterShotPrompt(appearance, shot, char.name, char.tier, char.groupSize, chained, refKind);
          const gen = (prompt: string) => generateImage({ prompt, aspect_ratio: ASPECT[shot], ...(chained ? { image_input: [ref!] } : {}) }, ctx);
          if (shot === "full" && char.tier !== "CROWD") {
            // Framing + Stage 46D proportion guard (one vision call per attempt, bounded retries); the best
            // candidate is kept when all attempts fail and its remaining defects are logged.
            const r = await generateFullBodyWithGuard(basePrompt, gen, { child: isChildAppearance(appearance), label: char.name });
            remote = r.url;
            if (r.proportionsWarning?.length) console.warn(`[characters/shot] proportionsWarning for ${char.name}/full:`, JSON.stringify(r.proportionsWarning));
          } else {
            remote = await gen(basePrompt);
          }
          s3Key = `media/public/characters/${projectId}/${char.id}/${VISUAL_STYLE_ID}/${shot}-${Date.now()}.png`;
        }
        const url = await uploadRemoteToS3(remote, s3Key, "image/png");

        // Write ONLY the regenerated slot (extras: replace the element at `index`, re-read to avoid clobbering).
        if (shot === "extra") {
          const fresh = await prisma.character.findUnique({ where: { id: characterId }, select: { imageExtra: true } });
          const arr = parseImageArray(fresh?.imageExtra);
          if (index! < arr.length) arr[index!] = url; else arr.push(url);
          await prisma.character.update({ where: { id: characterId }, data: { imageExtra: JSON.stringify(arr) } });
        } else {
          await prisma.character.update({ where: { id: characterId }, data: { [FIELD[shot]]: url } });
        }

        // Rendered scenes with this character now show an outdated look.
        await prisma.scene.updateMany({
          where: { characters: { some: { characterId } }, videoUrl: { not: null } },
          data: { lookStale: true },
        }).catch(() => {});

        await completeJob(job.id, { slot: slotKey, url, characterId }, "Фото готово");
      } catch (e: any) {
        console.error(`[characters/shot] ${slotKey} failed for ${char.name}:`, e?.message ?? e);
        await failJob(job.id, e?.message ?? "Shot regeneration failed");
        await refund(e?.message ?? "failed");
      }
    });

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - CHARACTER_REFERENCE_COST });
  } catch (err: any) {
    console.error("[characters/shot] error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
