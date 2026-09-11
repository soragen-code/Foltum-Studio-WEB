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


-- Model picker: persist the chosen video model / provider per scene so batch continuation
-- and single-scene regeneration reuse the producer's choice ("seedance" default, or "kling").
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
