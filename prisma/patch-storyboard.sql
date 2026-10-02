-- v2: сториборд серий (вкладка «Сториборд» страницы эпизода). Additive & idempotent.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "episodeStoryboardV2" JSONB;
