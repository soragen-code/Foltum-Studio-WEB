export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { isRefusal } from "@/lib/frame-state";
import { stripPreviousCameraLine } from "@/lib/prompt-seam";
import { resolveVideoPredecessor } from "@/lib/reangle";
import {
  PROMPT_VERSION,
  regenerateBlock,
  SCENE_BLOCK_NAMES,
  type SceneBlockInput,
  type SceneBlockName,
} from "@/lib/prompts";

/**
 * POST /api/ai/scenes/[id]/prompt/block
 *
 * Regenerate ONLY a single block of a scene's deterministic block-assembled prompt (Stage 165).
 * Body: { block: SceneBlockName } — one of the nine block names (style | location | character |
 * continuityIn | action | dialogue | camera | continuityOut | negative).
 *
 * The named block is recomputed from the current scene/cast/location inputs and spliced into the
 * previously-stored assembled prompt (every other block is carried over verbatim from
 * Scene.promptBlocks when present). The refreshed { version, prompt, blocks, cameraMove } is persisted
 * back to Scene.promptBlocks / Scene.promptVersion. Same ownership chain as the prompt GET route.
 *
 * Response: { ok, block, value, prompt, version, cameraMove }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const block = (body as { block?: unknown } | null)?.block;
  if (typeof block !== "string" || !SCENE_BLOCK_NAMES.includes(block as SceneBlockName)) {
    return NextResponse.json({ error: `Invalid block. Expected one of: ${SCENE_BLOCK_NAMES.join(", ")}` }, { status: 400 });
  }

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: true }, orderBy: { characterId: "asc" } },
      episode: { select: { location: { select: { id: true, name: true, imageUrl: true, setInventory: true } } } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  const input = buildSceneBlockInput(scene, await resolvePreviousEndState(scene));
  // Splice: only `block` is recomputed; the rest come from the stored blocks (when present).
  const storedBlocks = readStoredBlocks(scene.promptBlocks);
  const assembled = regenerateBlock(input, block as SceneBlockName, storedBlocks);

  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      promptBlocks: { version: PROMPT_VERSION, prompt: assembled.prompt, blocks: assembled.blocks, cameraMove: assembled.cameraMove },
      promptVersion: PROMPT_VERSION,
    },
  });

  return NextResponse.json({
    ok: true,
    block,
    value: assembled.blocks[block as SceneBlockName],
    prompt: assembled.prompt,
    cameraMove: assembled.cameraMove,
    version: PROMPT_VERSION,
  });
}

/** Best-effort predecessor end-state (continuity anchor), mirroring the prompt GET route. */
async function resolvePreviousEndState(scene: { id: string; [k: string]: unknown }): Promise<string | null> {
  try {
    const previousRow = await resolveVideoPredecessor(prisma, scene as never);
    const raw = previousRow && !isRefusal(previousRow.endStateActual) ? previousRow.endStateActual : null;
    return raw ? stripPreviousCameraLine(raw) || null : null;
  } catch {
    return null; // a blocked/unready predecessor must never break per-block regeneration
  }
}

/** Read the previously-stored per-block strings out of Scene.promptBlocks (defensive). */
function readStoredBlocks(promptBlocks: unknown): Partial<Record<SceneBlockName, string>> | null {
  if (!promptBlocks || typeof promptBlocks !== "object") return null;
  const blocks = (promptBlocks as { blocks?: unknown }).blocks;
  if (!blocks || typeof blocks !== "object") return null;
  const out: Partial<Record<SceneBlockName, string>> = {};
  for (const name of SCENE_BLOCK_NAMES) {
    const v = (blocks as Record<string, unknown>)[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

/**
 * Map a loaded scene row (+ predecessor end-state) into the pure SceneBlockInput. Every new field
 * (beatType, SeasonState, per-character gender) is read defensively so legacy rows still assemble.
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
      // beatType arrives in Stage 3/5 — absent today, read defensively.
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
    // SeasonState does not exist until Stage 4 — pass null so the blocks fall back to the cast / scene.
    seasonState: null,
    previous: previousEndState ? { endState: previousEndState, cameraMove: null } : null,
    // dialogueLanguage default (English) — the project language wiring lands with later stages.
    dialogueLanguage: null,
  };
}
