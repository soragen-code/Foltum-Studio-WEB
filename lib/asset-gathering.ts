/**
 * Stage 174 — ASSET GATHERING orchestrator + reconciliation (Storyboard only).
 *
 * Runs BEFORE the storyboard board split. It walks an episode's script-derived assets, reconciles them
 * against the project library, and auto-generates ONLY the missing ones by reusing the EXISTING reference
 * workers (never a new image path):
 *   - characters : EpisodeCharacter links → Character.imageFull || imageFront   (worker "characters")
 *   - locations  : Episode.locationId ∪ every Scene.locationId → Location.imageUrl (worker "location_image")
 *   - props      : EpisodeArtifact links → Artifact.imageUrl (frame 0)          (worker "artifacts", free)
 *
 * Only assets that actually appear in THIS episode's script are considered — the same sources the board
 * split itself resolves cast/location from (loadEpisodeCharacters / episode+scene locations), so nothing
 * that isn't in the script is ever generated.
 *
 * BLOCKING vs. gathered: characters and locations are the references the board renderer consumes (identity
 * refs in image_input, the location establishing anchor), so the split BLOCKS until they are all READY.
 * Props (artifacts) are supplementary reference frames the board pipeline does not consume and are extracted
 * lazily from the script; they are gathered in parallel (free, best-effort) but never hard-block the split,
 * so a prop-less or not-yet-extracted episode can never dead-lock the gate.
 *
 * Backward compatibility: an episode whose characters and locations are all already present reconciles with
 * zero blocking-missing → the gate passes through instantly and NOTHING is charged or enqueued (exactly the
 * pre-Stage-174 behaviour). Library assets are never regenerated or re-charged.
 */
import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";
import { runArtifactImagesJob } from "@/lib/workers/artifact-images-job";
import { startLocationImageJob, LOCATION_SET_COST } from "@/lib/location-refs";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";
import { normalizeImageModel } from "@/lib/ai-models";

/** A usable reference URL is an https URL that actually points at a stored image. */
const validUrl = (u?: string | null): u is string => typeof u === "string" && u.startsWith("http") && u.length > 10;

export type AssetKind = "character" | "location" | "prop";

/** One required asset resolved against the library (ready = a usable reference already exists). */
export interface RequiredAsset {
  kind: AssetKind;
  id: string;
  name: string;
  ready: boolean;
}

/** Per-kind reconciliation counts + the ids that still need generation. */
export interface KindStatus {
  ready: number;
  missing: number;
  total: number;
  missingIds: string[];
}

/** Full reconciliation of an episode's script-derived assets against the library. */
export interface AssetReconciliation {
  characters: KindStatus;
  locations: KindStatus;
  props: KindStatus;
  /** Missing assets the board renderer consumes (characters + locations) — these block the split. */
  blockingMissing: number;
  /** All missing assets across every kind (props included) — for display only. */
  totalMissing: number;
}

const emptyKind = (): KindStatus => ({ ready: 0, missing: 0, total: 0, missingIds: [] });

/**
 * PURE reconciliation: fold a flat list of already-resolved RequiredAsset entries into per-kind counts.
 * Unit-testable — no DB, no side effects. `blockingMissing` counts only characters + locations.
 */
export function reconcile(assets: RequiredAsset[]): AssetReconciliation {
  const out: AssetReconciliation = {
    characters: emptyKind(),
    locations: emptyKind(),
    props: emptyKind(),
    blockingMissing: 0,
    totalMissing: 0,
  };
  const bucket = (k: AssetKind): KindStatus =>
    k === "character" ? out.characters : k === "location" ? out.locations : out.props;
  for (const a of assets) {
    const b = bucket(a.kind);
    b.total += 1;
    if (a.ready) b.ready += 1;
    else { b.missing += 1; b.missingIds.push(a.id); }
  }
  out.blockingMissing = out.characters.missing + out.locations.missing;
  out.totalMissing = out.characters.missing + out.locations.missing + out.props.missing;
  return out;
}

/**
 * Load an episode's COMPLETE, deduped set of script-derived required assets and resolve each against the
 * library. Impure (reads the DB) but returns plain data so `reconcile` above stays pure/testable.
 */
export async function loadRequiredAssets(episodeId: string): Promise<RequiredAsset[]> {
  const assets: RequiredAsset[] = [];

  // ---- Characters: the episode cast (same source the board split uses: EpisodeCharacter links) ----
  const cast = await prisma.episodeCharacter.findMany({
    where: { episodeId },
    include: { character: { select: { id: true, name: true, imageFull: true, imageFront: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const { character: c } of cast) {
    assets.push({ kind: "character", id: c.id, name: c.name, ready: validUrl(c.imageFull) || validUrl(c.imageFront) });
  }

  // ---- Locations: the episode's bound location ∪ every location a scene is bound to (deduped) ----
  const episode = await prisma.episode.findUnique({ where: { id: episodeId }, select: { locationId: true } });
  const sceneLocs = await prisma.scene.findMany({ where: { episodeId, locationId: { not: null } }, select: { locationId: true } });
  const locationIds = Array.from(new Set([episode?.locationId ?? null, ...sceneLocs.map((s) => s.locationId)].filter((x): x is string => !!x)));
  if (locationIds.length) {
    const locs = await prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true, imageUrl: true } });
    for (const l of locs) assets.push({ kind: "location", id: l.id, name: l.name, ready: validUrl(l.imageUrl) });
  }

  // ---- Props: the episode's important objects (artifacts extracted from the script), frame 0 = imageUrl ----
  const props = await prisma.episodeArtifact.findMany({
    where: { episodeId },
    include: { artifact: { select: { id: true, name: true, imageUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const { artifact: a } of props) {
    assets.push({ kind: "prop", id: a.id, name: a.name, ready: validUrl(a.imageUrl) });
  }

  return assets;
}

/** Convenience: load + reconcile an episode's assets in one call. */
export async function reconcileEpisodeAssets(episodeId: string): Promise<AssetReconciliation> {
  return reconcile(await loadRequiredAssets(episodeId));
}

/**
 * Charge + start the "characters" reference job for the given characters — mirrors POST
 * /api/ai/characters/references exactly (same job type, cost = N × CHARACTER_REFERENCE_COST, refund on
 * failure) so the SAME worker (runCharacterImagesJob) and cost constant are reused, not a new path.
 * Idempotent: an active "characters" job is resumed (no extra charge).
 */
async function startCharacterReferencesJob(opts: {
  user: { id: string; credits: number | null };
  projectId: string;
  characterIds: string[];
  imageModel?: string;
}): Promise<{ jobId: string | null; count: number; cost: number } | { error: string; status: 402 }> {
  const { user, projectId, imageModel } = opts;
  const characterIds = Array.from(new Set(opts.characterIds));
  if (characterIds.length === 0) return { jobId: null, count: 0, cost: 0 };

  await failStaleJobs({ projectId, type: "characters" });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: "characters", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return { jobId: active.id, count: 0, cost: 0 };

  const cost = characterIds.length * CHARACTER_REFERENCE_COST;
  if ((user.credits ?? 0) < cost) return { error: `Insufficient credits: need ${cost}, balance ${user.credits ?? 0}`, status: 402 };

  const chars = await prisma.character.findMany({ where: { id: { in: characterIds } }, select: { id: true, name: true } });
  if (cost > 0) {
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Character references: ${chars.length} pcs.` } });
  }
  // Draft characters become approved once we commit to generating their references (matches the references route).
  await prisma.character.updateMany({ where: { id: { in: characterIds }, status: "draft" }, data: { status: "approved" } });

  const job = await prisma.generationJob.create({
    data: { type: "characters", status: "processing", progress: 5, message: `Generating references for ${characterIds.length} characters…`, projectId },
  });
  runInBackground(async () => {
    await runCharacterImagesJob({ jobId: job.id, projectId, characterIds, imageModel: normalizeImageModel(imageModel) });
    try {
      const after = await prisma.character.findMany({ where: { id: { in: characterIds } }, select: { id: true, name: true, imageFront: true, imageFull: true } });
      const none = after.filter((c) => !c.imageFull && !c.imageFront);
      if (none.length) {
        const refund = none.length * CHARACTER_REFERENCE_COST;
        await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
        await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Refund: references were not generated (${none.map((c) => c.name).join(", ")})` } });
      }
    } catch (e) { console.error("[asset-gathering] character refund check failed:", e); }
  });
  return { jobId: job.id, count: characterIds.length, cost };
}

/**
 * Start the "artifacts" (props) job for an episode — mirrors POST /api/ai/episodes/[episodeId]/artifacts.
 * Reference frames are supplementary, so NO credits are charged. Idempotent: an active "artifacts" job is
 * resumed. The worker itself extracts the important objects from the script (once) and fills missing frames.
 */
async function startArtifactImagesJob(projectId: string, episodeId: string): Promise<string | null> {
  await failStaleJobs({ projectId, type: "artifacts" });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: "artifacts", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return active.id;
  const job = await prisma.generationJob.create({
    data: { type: "artifacts", status: "processing", progress: 5, message: "Identifying important objects in the episode…", projectId },
  });
  runInBackground(async () => { await runArtifactImagesJob({ jobId: job.id, projectId, episodeId }); });
  return job.id;
}

export interface GatherResult {
  reconciliation: AssetReconciliation;
  /** Total credits charged this call (characters + locations; props are free). */
  charged: number;
  creditsRemaining: number;
  started: { characters?: string | null; locations?: string | null; props?: string | null };
  /** Set when the user cannot afford the missing character + location references (caller returns 402). */
  insufficientCredits?: { need: number; have: number };
}

/**
 * Reconcile the episode and, for every MISSING asset, enqueue generation via the existing workers, charging
 * credits up-front (characters + locations). Props are gathered for free in parallel. Never charges for or
 * regenerates assets already in the library. Returns the reconciliation and what was charged/started.
 *
 * If the user cannot afford the missing character + location references, NOTHING is charged or started and
 * `insufficientCredits` is set so the caller can return HTTP 402.
 */
export async function gatherMissingAssets(opts: {
  user: { id: string; credits: number | null };
  projectId: string;
  episodeId: string;
  imageModel?: string;
}): Promise<GatherResult> {
  const { user, projectId, episodeId, imageModel } = opts;
  const reconciliation = await reconcileEpisodeAssets(episodeId);
  const have = user.credits ?? 0;
  const need = reconciliation.characters.missing * CHARACTER_REFERENCE_COST + reconciliation.locations.missing * LOCATION_SET_COST;

  // Combined affordability pre-check so we never partially charge (e.g. characters but not locations).
  if (need > have) {
    return { reconciliation, charged: 0, creditsRemaining: have, started: {}, insufficientCredits: { need, have } };
  }

  const started: GatherResult["started"] = {};
  let charged = 0;

  // Characters (charged).
  if (reconciliation.characters.missingIds.length) {
    const r = await startCharacterReferencesJob({ user, projectId, characterIds: reconciliation.characters.missingIds, imageModel });
    if ("error" in r) return { reconciliation, charged, creditsRemaining: have - charged, started, insufficientCredits: { need, have } };
    started.characters = r.jobId;
    charged += r.cost;
  }

  // Locations (charged) — reuse the canonical startLocationImageJob (charge + refund pattern).
  if (reconciliation.locations.missingIds.length) {
    const r = await startLocationImageJob({ user: { id: user.id, credits: have - charged }, projectId, locationIds: reconciliation.locations.missingIds, imageModel });
    if ("error" in r) return { reconciliation, charged, creditsRemaining: have - charged, started, insufficientCredits: { need, have } };
    started.locations = r.jobId;
    charged += r.cost ?? 0;
  }

  // Props (free, best-effort). Gather them whenever the gate is engaging (missing blocking assets) OR when
  // known linked artifacts still lack frames — never blocks the split and never charges.
  if (reconciliation.props.missingIds.length || reconciliation.blockingMissing > 0) {
    started.props = await startArtifactImagesJob(projectId, episodeId);
  }

  return { reconciliation, charged, creditsRemaining: have - charged, started };
}
