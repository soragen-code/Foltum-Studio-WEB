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



-- Stage 122: scene region plates — pre-generated environment plates (Seedream edits of the master layout) of the
-- exact part of the location a scene happens in, sent as the PRIMARY geometry/background reference into the scene's
-- video clips (the last-frame re-angle is kept only for people/motion). All additive & nullable; legacy rows fall
-- back to the master plates (no auto-migration). Idempotent: ADD COLUMN IF NOT EXISTS only, never dropped.
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "regionPlates" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "regionKey" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "regionDesc" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "regionPlateUrl" TEXT;


-- Stage 125: character sex as a single source of truth. "gender" ("male" | "female") is set by the idea
-- LLM per character (consistent with role/kinship — a "мать" is female, an "отец" is male) and forced into
-- the character reference prompt so the image model can never render the wrong sex (the "мать Николя"
-- rendered as a man bug). Additive & nullable; legacy rows stay null and fall back to a heuristic derived
-- from role/appearance at reference-generation time (no auto-migration of existing images). Idempotent.
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "gender" TEXT;



-- Stage 127: STORYBOARD production mode (alternative to SCENES, chosen AFTER the story is built).
-- Episode.mode: null / "SCENES" = classic 9-scene pipeline (keyframe/i2v ban in force); "STORYBOARD" = 12-15
-- keyframe boards animated via image-to-video into a ~90s cut (keyframe/i2v ban lifted only for this mode).
-- Board holds each keyframe board (frame still + animated clip). All additive & nullable / IF NOT EXISTS;
-- legacy episodes keep mode = null → treated as SCENES. Idempotent.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "mode" TEXT;

CREATE TABLE IF NOT EXISTS "Board" (
  "id"               TEXT NOT NULL,
  "episodeId"        TEXT NOT NULL,
  "index"            INTEGER NOT NULL,
  "actionOrDialogue" TEXT NOT NULL,
  "motionEn"         TEXT,
  "imagePrompt"      TEXT,
  "imageUrl"         TEXT,
  "videoUrl"         TEXT,
  "durationSec"      INTEGER,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "error"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Board_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Board_episodeId_index_key" ON "Board"("episodeId", "index");
CREATE INDEX IF NOT EXISTS "Board_episodeId_idx" ON "Board"("episodeId");

DO $$ BEGIN
  ALTER TABLE "Board" ADD CONSTRAINT "Board_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Stage 131: bind Storyboard boards to their location zone so all boards of a location share one geometry
-- authority (master/region plate), the same stabilization SCENES uses (Stage 122). Additive & idempotent;
-- legacy boards keep NULL and fall back to the episode Location master plate. STORYBOARD only.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "region"    TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "regionKey" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "plateUrl"  TEXT;

-- Stage 132: Storyboard-only direction data; additive, legacy boards remain NULL.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "directionJson" TEXT;

-- Stage 142: SCENE ANCHOR FRAME per storyboard scene (additive, idempotent)
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "anchorUrl" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "anchorBoardId" TEXT;

-- Group B: transparency fields — the actual animate prompt, the actual references passed to each model, and the
-- fixed frame seed. Additive & idempotent; legacy boards remain NULL. STORYBOARD only.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "motionPromptEn" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "frameRefs"      JSONB;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "animateRefs"    JSONB;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "frameSeed"      INTEGER;


-- Stage 155: mark a season whose fullStory is an author-uploaded plot file (drives the episode
-- scripts as the authoritative source) rather than the deterministically built auto plot. Additive & idempotent.
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "userPlotUploaded" BOOLEAN NOT NULL DEFAULT false;



-- Stage 162: per-scene location binding. Scenes are bound to a Location derived from the episode's
-- finished shooting script (not all up front). Plain nullable column — the safest additive change; no
-- FK constraint is added (an orphaned locationId simply resolves to null via the relation include, and
-- the app falls back to the episode location). Additive & idempotent.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
CREATE INDEX IF NOT EXISTS "Scene_locationId_idx" ON "Scene" ("locationId");



-- Stage 165 (task Stage 6): deterministic block-assembled scene prompts. Store the assembled prompt
-- and its individual blocks for debugging / per-block regeneration, plus the PROMPT_VERSION that
-- produced them. Both nullable — legacy rows stay NULL until a prompt is next assembled. Additive & idempotent.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "promptBlocks" JSONB;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;





-- Stage 166 (task Stage 5): reworked episode-script generation. Record the episode's single emotional-peak
-- scene index and the episode-script PROMPT_VERSION the script was generated with. Both nullable — legacy
-- rows stay NULL. Additive & idempotent.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "peakSceneIndex" INTEGER;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;



-- Stage 167 (task Stage 5+6 replacement): the SHOT becomes the atomic unit of generation, below the Scene.
-- Scene gains an escalation ladder (5-7 steps) and a key prop; a new Shot table holds the ordered shots each
-- scene is chain-generated from. All additive & idempotent; legacy scenes keep NULL / no shots and still play.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "escalationBeats" JSONB;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "keyProp" TEXT;

CREATE TABLE IF NOT EXISTS "Shot" (
  "id"              TEXT NOT NULL,
  "sceneId"         TEXT NOT NULL,
  "index"           INTEGER NOT NULL,
  "shotType"        TEXT NOT NULL DEFAULT 'dialogue',
  "size"            TEXT,
  "duration"        DOUBLE PRECISION,
  "speakerId"       TEXT,
  "line"            TEXT,
  "lineTranslation" TEXT,
  "reactionOfId"    TEXT,
  "escalationBeat"  TEXT,
  "postFx"          TEXT NOT NULL DEFAULT 'none',
  "matchCutIn"      TEXT,
  "matchCutOut"     TEXT,
  "prompt"          TEXT,
  "promptBlocks"    JSONB,
  "promptVersion"   TEXT,
  "videoUrl"        TEXT,
  "lastFrameUrl"    TEXT,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "error"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Shot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Shot_sceneId_index_key" ON "Shot"("sceneId", "index");
CREATE INDEX IF NOT EXISTS "Shot_sceneId_idx" ON "Shot"("sceneId");

DO $$ BEGIN
  ALTER TABLE "Shot" ADD CONSTRAINT "Shot_sceneId_fkey"
    FOREIGN KEY ("sceneId") REFERENCES "Scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;



-- Stage 3 (task Stage 3 seasonMap): additive, idempotent — the validated per-episode SEASON MAP and its
-- prompt version on the Season row. Old seasons keep NULL and build episode outlines exactly as before.
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "seasonMap" JSONB;
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "seasonMapVersion" TEXT;



-- Stage 1 (dramaBible): additive, idempotent — the structured story bible and its prompt version on the
-- Project row. Old projects keep NULL and generate the synopsis exactly as before (backward compatible).
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "dramaBible" JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "dramaBibleVersion" TEXT;



-- Stage 4 (task Stage 4): additive, idempotent — the live per-season WORLD-STATE. After each episode is
-- approved the state is refreshed by a separate LLM call and fed into the next episode's prompt instead of
-- the old text tail. Old seasons keep zero rows and fall back to the previous behaviour (backward compatible).
CREATE TABLE IF NOT EXISTS "SeasonState" (
  "id"                    TEXT NOT NULL,
  "seasonId"              TEXT NOT NULL,
  "reflectsEpisodeNumber" INTEGER,
  "state"                 JSONB NOT NULL,
  "version"               TEXT NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SeasonState_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SeasonState_seasonId_idx" ON "SeasonState"("seasonId");

DO $$ BEGIN
  ALTER TABLE "SeasonState" ADD CONSTRAINT "SeasonState_seasonId_fkey"
    FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Stage 2 (Stage171) — cast depth (from dramaBible) + location dramaticFunction. Additive + idempotent; NO drops.
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "voiceProfile" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "speechTics" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "secretsKnown" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "relationshipsTo" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "castPromptVersion" TEXT;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "dramaticFunction" TEXT;



-- Stage 7 (task Stage 7 — critic-driven generation) — GenerationLog. Additive + idempotent; NO drops.
CREATE TABLE IF NOT EXISTS "GenerationLog" (
  "id"            TEXT NOT NULL,
  "projectId"     TEXT,
  "seasonId"      TEXT,
  "episodeId"     TEXT,
  "kind"          TEXT NOT NULL,
  "model"         TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "finalScore"    DOUBLE PRECISION,
  "accepted"      BOOLEAN NOT NULL DEFAULT false,
  "notes"         JSONB,
  "error"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GenerationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GenerationLog_projectId_idx" ON "GenerationLog"("projectId");
CREATE INDEX IF NOT EXISTS "GenerationLog_kind_idx" ON "GenerationLog"("kind");

-- Stage 8 (final): project-level dialogue language (default English). Additive + idempotent.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "dialogueLanguage" TEXT DEFAULT 'en';



-- P7/P10 (pipeline fix): staleness flags for derived rows. Additive + idempotent.
--  Scene.stale       — the approved Episode.script changed after this scene was derived from it.
--  SeasonState.stale — an earlier episode was reworked after this season-state was written.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "stale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SeasonState" ADD COLUMN IF NOT EXISTS "stale" BOOLEAN NOT NULL DEFAULT false;



-- Optional single "face photo" per character (public S3 URL). Uploaded at character creation and fed FIRST
-- into every character reference generation so a user can cast their own face in the lead role. Additive,
-- nullable & idempotent; legacy rows stay NULL and generate exactly as before.
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "faceImageUrl" TEXT;

-- Generation unit per episode (additive + idempotent). "scene" (DEFAULT: 1 scene = 1 clip) | "shots" («Шоты» mode).
-- Existing episodes default to "scene" so the restored default scene pipeline is used unless the producer opts into «Шоты».
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "generationMode" TEXT NOT NULL DEFAULT 'scene';



-- Sub-locations (distinct spots / angles WITHIN a single location). The script marks the spot of every scene
-- with a machine-readable [SPOT: ...] tag; the backend extracts the unique sub-locations per location and
-- generates ONE reusable 9:16 angle reference for each, cached on the Location and reused across every scene at
-- that spot. Additive, nullable & idempotent; legacy rows stay NULL and fall back to the base location reference.
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "subLocation" TEXT;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "subLocationRefs" TEXT;


-- Paid-only credit model: 1 credit = 1 second of video = $1. New accounts get NO free/welcome
-- credits — the default starting balance is 0 (was 100). Idempotent; existing rows are untouched
-- by this DDL (their balances are handled separately by the admin zero-out).
ALTER TABLE "User" ALTER COLUMN "credits" SET DEFAULT 0;

-- Short human-readable scene title (2-6 words, no location dump) produced by the script writer and shown
-- as the scene heading in the readable script. Additive, nullable & idempotent; legacy / manual scripts
-- leave it NULL and the UI falls back to "Scene N".
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "title" TEXT;



-- Stage 200 (3-step approval flow): the short "story idea" logline (2–3 sentences) and its approval
-- flag — the FIRST approval gate, generated before the synopsis. Additive, nullable & idempotent;
-- legacy rows keep NULL / false and skip straight to the synopsis step exactly as before.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "logline" TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "loglineApproved" BOOLEAN NOT NULL DEFAULT false;



-- Stage 210 (batched story generation): how many per-episode synopses have been generated so far for the
-- season story. The story is now generated in batches of 3 episodes; this counter tracks progress so the
-- "generate next 3" action knows where to continue. Additive, nullable & idempotent; legacy rows keep NULL
-- and behave exactly as the previous all-at-once flow.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "storyEpisodesGenerated" INTEGER;



-- Stage 173 (task 1): AI-recommended number of episodes, computed from the approved synopsis right after
-- synopsis approval. Shown to the producer as the suggested value (they may keep it or override via
-- "episodeCount"). Additive, nullable & idempotent; legacy rows keep NULL and behave exactly as before.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "recommendedEpisodeCount" INTEGER;

-- Stage 173 (task 2): the episode PLOT — a prose beat-sheet (events, characters, locations/sub-locations,
-- scene order) generated on the episode-plot page BEFORE the script, sequentially on demand. It is the
-- AUTHORITATIVE BASIS for the script (task 3). plotStatus drives the plot page UI. Additive, nullable &
-- idempotent; legacy rows keep NULL and are unaffected.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "plot" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "plotStatus" TEXT;

-- Stage 174: asset-gathering gate state for STORYBOARD episodes (additive, nullable).
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "boardGate" TEXT;



-- Stage 220 (PER-SCENE storyboard): each Scene yields exactly two boards — a start frame and an end frame —
-- plus one start→end i2v clip on the start board. sceneId links the board to its Scene, boardRole is
-- "start"/"end", castInFrame carries the per-scene shot plan (onScreen/entering/exiting + frame descriptions
-- + motion + dialogue). Additive, nullable & idempotent; legacy boards keep NULL and are unaffected.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "sceneId" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "boardRole" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "castInFrame" JSONB;



-- Site localization: per-user UI language ("ru" | "en"). Additive, non-null with a default so existing
-- rows backfill to Russian (the current UI language). Never renames/drops.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'ru';



-- Stage 233: user-edited prompt overrides per board. When set, the render workers use them VERBATIM
-- (imagePromptOverride → frame/image prompt, motionPromptOverride → i2v animation prompt); NULL = auto prompt.
-- Additive, nullable & idempotent.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "imagePromptOverride" TEXT;
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "motionPromptOverride" TEXT;



-- Stage 234: "Manual mode" — standalone photo/video generations outside of projects (/manual). Idempotent.
CREATE TABLE IF NOT EXISTS "ManualGeneration" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "referenceUrls" JSONB,
  "sourceImageUrl" TEXT,
  "resultUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "jobId" TEXT,
  "cost" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualGeneration_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ManualGeneration_userId_createdAt_idx" ON "ManualGeneration"("userId", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualGeneration_userId_fkey') THEN
    ALTER TABLE "ManualGeneration" ADD CONSTRAINT "ManualGeneration_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;



-- Stage 234h: "Location Generator" (/manual) — saved location entity with four wall labels + four generated
-- 9:16 plates (front/back/left/right), reusable in the video-prompt builder. Additive & idempotent.
CREATE TABLE IF NOT EXISTS "ManualLocation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "frontLabel" TEXT NOT NULL,
  "backLabel" TEXT NOT NULL,
  "leftLabel" TEXT NOT NULL,
  "rightLabel" TEXT NOT NULL,
  "frontUrl" TEXT,
  "backUrl" TEXT,
  "leftUrl" TEXT,
  "rightUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualLocation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ManualLocation_userId_createdAt_idx" ON "ManualLocation"("userId", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualLocation_userId_fkey') THEN
    ALTER TABLE "ManualLocation" ADD CONSTRAINT "ManualLocation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Stage 235: varied storyboard shot coverage ───────────────────────────────────────────────
-- Per-board chosen SHOT SCALE (ShotSize string, e.g. "CLOSE-UP", "TWO-SHOT", "WIDE ESTABLISHING") so generated
-- storyboard boards rotate wide / medium / close-up / two-shot board-to-board instead of a count-based single
-- size. Additive & idempotent; legacy boards keep NULL.
ALTER TABLE "Board" ADD COLUMN IF NOT EXISTS "shotType" TEXT;
