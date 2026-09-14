-- Idempotent schema patches applied at build time (Vercel has DATABASE_URL).
-- Safe to run repeatedly.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "lastFrameUrl" TEXT;

-- Stage 1 (new flow): additive columns only — existing data keeps working.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "powerTier" TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "idea" TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "charactersApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "age" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "firstAppearance" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "logline" TEXT;
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "logline" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "locationName" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "locationDesc" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "script" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
CREATE TABLE IF NOT EXISTS "EpisodeCharacter" (
  "id" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EpisodeCharacter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EpisodeCharacter_episodeId_characterId_key" ON "EpisodeCharacter"("episodeId", "characterId");
CREATE INDEX IF NOT EXISTS "EpisodeCharacter_characterId_idx" ON "EpisodeCharacter"("characterId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EpisodeCharacter_episodeId_fkey') THEN
    ALTER TABLE "EpisodeCharacter" ADD CONSTRAINT "EpisodeCharacter_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EpisodeCharacter_characterId_fkey') THEN
    ALTER TABLE "EpisodeCharacter" ADD CONSTRAINT "EpisodeCharacter_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
-- Backfill: legacy projects carry only `tier`; keep powerTier consistent with it (tier is always written alongside powerTier).
UPDATE "Project" SET "powerTier" = CASE "tier" WHEN 'minimum' THEN 'LOW' WHEN 'maximum' THEN 'HIGH' ELSE 'MEDIUM' END
  WHERE "powerTier" <> CASE "tier" WHEN 'minimum' THEN 'LOW' WHEN 'maximum' THEN 'HIGH' ELSE 'MEDIUM' END;

-- Stage 2 (season script): additive columns only.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "arcRole" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "shotType" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "durationSec" INTEGER;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "action" TEXT;

-- Stage 3 (locations + extended cast): additive only.
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'MAIN';
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "groupSize" INTEGER;
CREATE TABLE IF NOT EXISTS "Location" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "visualPrompt" TEXT,
  "imageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Location_projectId_idx" ON "Location"("projectId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Location_projectId_fkey') THEN
    ALTER TABLE "Location" ADD CONSTRAINT "Location_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Episode_locationId_fkey') THEN
    ALTER TABLE "Episode" ADD CONSTRAINT "Episode_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Stage 3b: location references from several camera angles (same light).
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "imageReverse" TEXT;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "imageDetail" TEXT;

-- Stage 7: extra location angles/shots on demand (JSON array of image URLs).
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "imageExtra" TEXT;

-- Stage 4: English speech + per-scene burned-in subtitles (additive)
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "dialogueEn" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "subtitled" BOOLEAN NOT NULL DEFAULT false;

-- Stage 11: job cancellation (additive) — author can stop a long generation.
ALTER TABLE "GenerationJob" ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false;

-- Stage 11: scene continuity metadata (additive, nullable — old scenes keep working).
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "presence" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "entrances" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "continuesFrom" TEXT;



-- Stage 12: whole detailed season story with explicit episode markers (additive, nullable).
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "fullStory" TEXT;


-- Stage 12 (Commit D): off-screen narration scenes (additive, nullable — old scenes keep working).
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "sceneKind" TEXT DEFAULT 'dialogue';
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "voiceover" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "voiceoverLocal" TEXT;


-- Stage 14 (B): producer-chosen number of episodes for the season (additive, nullable — old projects keep AI-chosen count).
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "episodeCount" INTEGER;



-- Stage 14 (E): richer episode references — 5 character photos, artifacts/important objects (2 frames each).
-- All additive: new nullable column + new tables. Old projects keep working (columns default NULL / no rows).
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "imageExtra" TEXT;

CREATE TABLE IF NOT EXISTS "Artifact" (
  "id"           TEXT NOT NULL,
  "projectId"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "visualPrompt" TEXT,
  "imageUrl"     TEXT,
  "imageExtra"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Artifact_projectId_idx" ON "Artifact"("projectId");
DO $$ BEGIN
  ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "EpisodeArtifact" (
  "id"         TEXT NOT NULL,
  "episodeId"  TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EpisodeArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EpisodeArtifact_episodeId_artifactId_key" ON "EpisodeArtifact"("episodeId", "artifactId");
CREATE INDEX IF NOT EXISTS "EpisodeArtifact_artifactId_idx" ON "EpisodeArtifact"("artifactId");
DO $$ BEGIN
  ALTER TABLE "EpisodeArtifact" ADD CONSTRAINT "EpisodeArtifact_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EpisodeArtifact" ADD CONSTRAINT "EpisodeArtifact_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Stage 22: reference finalize/lock flag on Character and Location
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "refLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "refLocked" BOOLEAN NOT NULL DEFAULT false;


-- Persist the video model per scene (always "seedance" — Seedance 2.5; Stage 63 removed the Kling option).
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "videoModel" TEXT;


-- Stage 31: manual per-scene prompt override (additive, nullable). When non-empty it replaces
-- the auto-assembled final prompt TEXT verbatim; NULL = use the auto prompt. Frame/reference
-- chaining is unaffected.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "promptOverride" TEXT;

-- Stage 33: per-scene "send without reference images" toggle (additive, NOT NULL with default).
-- When true and the scene is not frame-chained, the video is submitted as plain text-to-video
-- (no character/location references). Chained scenes still use the previous scene's last frame.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "skipReferences" BOOLEAN NOT NULL DEFAULT false;

-- Stage 37: per-scene "skip previous frame" toggle (additive, NOT NULL with default).
-- When true the previous scene's last frame is NOT sent as a reference image; character portraits,
-- location angles and crowds are still sent as usual.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "skipPreviousFrame" BOOLEAN NOT NULL DEFAULT false;

-- Stage 40: scripted / actual end-state hand-off between scenes (additive, nullable).
-- endState = screenwriter's description of the final frame; endStateActual = vision-model description of the
-- real last frame (chain mode). The next scene's prompt opens with OPENING STATE = endStateActual ?? endState.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "endState" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "endStateActual" TEXT;

-- Stage 41: scripted START state of the scene's first frame (additive, nullable). OPENING STATE of a scene's prompt is
-- previous.endStateActual (chain mode) ?? scene.startState ?? previous.endState.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "startState" TEXT;

-- Stage 40: per-episode generation order ("parallel" | "chain") + chain-run bookkeeping.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "chainMode" TEXT NOT NULL DEFAULT 'parallel';
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "chainRunActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "chainRunNote" TEXT;

-- Stage 40: «Тестовая серия» — one-scene sandbox projects.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT false;

-- Location reference photo count depends on the required detail level (LLM-set), not on size.
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "detailLevel" TEXT;

-- Stage 46A: short synopsis step (premise + one-line logline per episode) approved before the season script.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "shortSynopsis" TEXT;

-- Stage 46B: production quality / fps of the last episode assembly (scenes are always 480p)
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "assembleQuality" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "assembleFps" INTEGER;

-- Stage 46C: Season entity fields + backfill of planned episode count from existing episodes
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "premise" TEXT;
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "previousSeasonId" TEXT;
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "episodeCount" INTEGER;
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "direction" TEXT;
UPDATE "Season" SET "episodeCount" = (SELECT count(*) FROM "Episode" e WHERE e."seasonId" = "Season".id) WHERE "episodeCount" IS NULL;

-- Stage 46B-1: live character look cache + stale marker per scene
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "lookCache" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "lookStale" BOOLEAN NOT NULL DEFAULT false;

-- Stage 46E: character manual prompt override + location auto-prompt snapshot
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "promptOverride" TEXT;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "visualPromptAuto" TEXT;

-- Stage 63: Kling and the per-episode video provider selection are gone — Seedance is the only video path.
-- The Stage 47 "Episode"."videoProvider" column is no longer read by any code path (applied to prod
-- only after the Stage 63 code went live, so no running deployment ever saw a missing column).
ALTER TABLE "Episode" DROP COLUMN IF EXISTS "videoProvider";


-- Stage 54: cached JSON snapshot of the episode prop registry (verbatim prop substitution)
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "propRegistry" TEXT;



-- Stage 59: durable "new 4-step flow" marker (idea → synopsis → season story → episodes).
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "newFlow" BOOLEAN NOT NULL DEFAULT false;



-- Stage 60: one previous version snapshot for one-step undo (character/location/scene edits)
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "prevSnapshot" JSONB;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "prevSnapshot" JSONB;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "prevSnapshot" JSONB;


-- Stage 64: storyboard scene-generation mode (per-episode mode + per-scene approved 9:16 frame)
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "sceneMode" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "storyboardUrl" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "storyboardApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "storyboardPrompt" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "storyboardJobId" TEXT;


-- Stage 72: storyboard mode removed from the app (single scene mode). Columns are kept for safety
-- (never dropped); every episode is normalized back to 'text' so nothing depends on the old mode.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Episode' AND column_name = 'sceneMode') THEN
    UPDATE "Episode" SET "sceneMode" = 'text' WHERE "sceneMode" IS DISTINCT FROM 'text';
  END IF;
END $$;


-- Stage 73: per-project generation provider (reference images / scene videos): replicate | wavespeed | modelark
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "imageProvider" TEXT NOT NULL DEFAULT 'replicate';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "videoProvider" TEXT NOT NULL DEFAULT 'wavespeed';

-- Stage 75: user-uploaded photo references per character (JSON array of public S3 URLs, max 4).
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "userRefs" TEXT;

-- Stage 98: chain generation is now the DEFAULT (the previous scene's real last frame is passed as
-- reference to the next scene). Only the column DEFAULT changes; existing rows keep their stored value.
ALTER TABLE "Episode" ALTER COLUMN "chainMode" SET DEFAULT 'chain';

-- Stage 102: the vision model sometimes REFUSED to describe the real last frame ("I'm sorry, I can't help
-- with identifying people…") and the refusal was saved as Scene.endStateActual, poisoning the next scene's
-- OPENING STATE. NULL every refusal-looking / too-short description so the chain falls back to the scripted
-- endState. Idempotent: matching rows are NULLed once, later runs touch nothing.
UPDATE "Scene" SET "endStateActual" = NULL
WHERE "endStateActual" IS NOT NULL
  AND ("endStateActual" ~* '(i''m sorry|can''t help|cannot help|unable to)' OR length(trim("endStateActual")) < 80);


-- Stage 104: WaveSpeed is the ONLY media provider. Normalise legacy provider values and the column default
-- (columns are kept — never dropped).
UPDATE "Project" SET "imageProvider" = 'wavespeed' WHERE "imageProvider" <> 'wavespeed';
UPDATE "Project" SET "videoProvider" = 'wavespeed' WHERE "videoProvider" <> 'wavespeed';
ALTER TABLE "Project" ALTER COLUMN "imageProvider" SET DEFAULT 'wavespeed';

-- Stage 104: keyframe-driven scenes (Seedream keyframe → Seedance image-to-video first/last frame).
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "keyframeUrl" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "keyframePrompt" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "keyframeStatus" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "keyframeError" TEXT;

-- Stage 113: full physical set inventory per location (one "object — placement" entry per line), written at idea stage.
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "setInventory" TEXT;
