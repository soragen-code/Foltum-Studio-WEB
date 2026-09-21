export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { isRefusal } from "@/lib/frame-state";
import { stripPreviousCameraLine } from "@/lib/prompt-seam";
import { resolveVideoPredecessor } from "@/lib/reangle";
import { normalizePromptOverride } from "@/lib/prompt-override";
import {
  PROMPT_VERSION,
  assembleScenePrompt,
  type SceneBlockInput,
} from "@/lib/prompts";
import { requireFeature } from "@/lib/entitlements";

/**
 * GET /api/ai/scenes/[id]/prompt
 *
 * Return the scene's FINAL prompt for the "View prompt" modal. When a manual override is stored it is
 * returned verbatim; otherwise the deterministic block-assembled prompt (Stage 165 / lib/prompts) is
 * computed and returned. The legacy buildScenePrompt path was removed with the legacy scene pipeline
 * (commit 29e1677), so this route now assembles from the nine ordered blocks — the SAME assembly the
 * per-block regen route and the scenes worker use.
 *
 * Response: { prompt, hasOverride, version }. Ownership: scene → episode → season → project → userId.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: true }, orderBy: { characterId: "asc" } },
      episode: { select: { location: { select: { id: true, name: true, imageUrl: true, setInventory: true } } } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  const hasOverride = !!(scene.promptOverride ?? "").trim();

  // Manual override wins verbatim — the worker submits it as-is.
  if (hasOverride) {
    return NextResponse.json({ prompt: scene.promptOverride!.trim(), hasOverride: true, version: scene.promptVersion ?? PROMPT_VERSION });
  }

  // No override → assemble deterministically from the nine ordered blocks.
  const assembled = assembleScenePrompt(buildSceneBlockInput(scene as unknown as LoadedScene, await resolvePreviousEndState(scene)));

  // Additively persist the assembled prompt + its blocks for debugging / per-block regen. Best-effort:
  // never let a persist failure break the read.
  try {
    await prisma.scene.update({
      where: { id: scene.id },
      data: {
        promptBlocks: { version: PROMPT_VERSION, prompt: assembled.prompt, blocks: assembled.blocks, cameraMove: assembled.cameraMove },
        promptVersion: PROMPT_VERSION,
      },
    });
  } catch { /* debug persistence only — ignore */ }

  return NextResponse.json({ prompt: assembled.prompt, hasOverride: false, version: PROMPT_VERSION });
}

/**
 * PUT /api/ai/scenes/[id]/prompt
 *
 * Save (reset) the scene's manual final-prompt override. Body: { prompt: string }.
 *   - non-empty (after normalization) → stored as Scene.promptOverride and used verbatim next generation;
 *   - empty / whitespace → resets to null (auto prompt is used again) and drops the memoised look cache so
 *     the next assembly is recomputed against the current rules.
 * Response: { ok, hasOverride, prompt }. Same ownership chain as GET.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  // Feature gate: manually saving a final-prompt override ("manual_prompt_edit") requires an active
  // Basic+ subscription. The access check runs FIRST; the save/reset logic below is unchanged.
  const gateUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscriptionTier: true, subscriptionExpiresAt: true },
  });
  const denied = requireFeature(gateUser, "manual_prompt_edit");
  if (denied) return NextResponse.json(denied, { status: 403 });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const raw = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "Invalid prompt" }, { status: 400 });
  }
  const normalized = normalizePromptOverride(raw);
  const promptOverride = normalized.length ? normalized : null;
  const isReset = promptOverride === null;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  const updated = await prisma.scene.update({
    where: { id: scene.id },
    data: {
      promptOverride,
      // Reset-to-auto also drops the hash-keyed look cache so the next assembly recomputes on the fresh rules.
      ...(isReset ? { lookCache: null, lookStale: false } : {}),
    },
    select: { promptOverride: true },
  });

  return NextResponse.json({
    ok: true,
    hasOverride: !!(updated.promptOverride ?? "").trim(),
    prompt: updated.promptOverride ?? null,
  });
}

/** Best-effort predecessor end-state (continuity anchor), mirroring the per-block regen route. */
async function resolvePreviousEndState(scene: { id: string; [k: string]: unknown }): Promise<string | null> {
  try {
    const previousRow = await resolveVideoPredecessor(prisma, scene as never);
    const raw = previousRow && !isRefusal(previousRow.endStateActual) ? previousRow.endStateActual : null;
    return raw ? stripPreviousCameraLine(raw) || null : null;
  } catch {
    return null; // a blocked/unready predecessor must never break prompt preview
  }
}

/**
 * Map a loaded scene row (+ predecessor end-state) into the pure SceneBlockInput. Every new field
 * (beatType, SeasonState, per-character gender) is read defensively so legacy rows still assemble.
 * Mirrors buildSceneBlockInput in ./block/route.ts.
 */
type LoadedScene = {
  sceneKind: string | null; locationDesc: string | null; videoPrompt: string | null; action: string | null;
  dialogue: string | null; dialogueEn: string | null; voiceover: string | null; startState: string | null;
  endState: string | null; continuesFrom: string | null; regionPlateUrl: string | null; id: string;
  characters: Array<{ characterId: string; character: { name: string; tier: string | null; appearance: string | null; age: string | null; gender: string | null } }>;
  episode: { location: { id: string; name: string | null; imageUrl: string | null; setInventory: string | null } | null };
};

function buildSceneBlockInput(scene: LoadedScene, previousEndState: string | null): SceneBlockInput {
  return {
    scene: {
      id: scene.id,
      sceneKind: scene.sceneKind,
      locationDesc: scene.locationDesc,
      videoPrompt: scene.videoPrompt,
      action: scene.action,
      dialogue: scene.dialogue,
      dialogueEn: scene.dialogueEn,
      voiceover: scene.voiceover,
      startState: scene.startState,
      endState: scene.endState,
      continuesFrom: scene.continuesFrom,
      beatType: (scene as { beatType?: string | null }).beatType ?? null,
    },
    characters: scene.characters.map(l => ({
      characterId: l.characterId,
      name: l.character.name,
      tier: l.character.tier,
      appearance: l.character.appearance,
      age: l.character.age,
      gender: l.character.gender,
    })),
    location: scene.episode.location
      ? { id: scene.episode.location.id, name: scene.episode.location.name, setInventory: scene.episode.location.setInventory, imageUrl: scene.episode.location.imageUrl }
      : null,
    regionPlateUrl: scene.regionPlateUrl,
    seasonState: null,
    previous: previousEndState ? { endState: previousEndState, cameraMove: null } : null,
    dialogueLanguage: null,
  };
}
