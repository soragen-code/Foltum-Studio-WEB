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

-- Stage 4: English speech + per-scene burned-in subtitles (additive)
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "dialogueEn" TEXT;
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "subtitled" BOOLEAN NOT NULL DEFAULT false;
