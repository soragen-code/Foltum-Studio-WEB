/**
 * Stage 107b — rebuild Season.fullStory from the existing episode structures (legacy data sync).
 *
 * For every Season whose episodes' descriptions ALL parse as 60-second footage (SHOT 1 / SHOT 2 / CLIFFHANGER),
 * fullStory is rebuilt deterministically via buildFullStoryFromStructure (Stage 106 format) and saved.
 * Seasons with a non-footage description, or with no episodes, are skipped with a reason. Idempotent.
 *
 * Usage (DATABASE_URL from the environment):
 *   DATABASE_URL=postgresql://... npx tsx --tsconfig tsconfig.json scripts/rebuild-full-story.ts
 *   DATABASE_URL=postgresql://... npx tsx --tsconfig tsconfig.json scripts/rebuild-full-story.ts --project <projectId>
 *   add --dry-run to print the plan without writing.
 */
import { PrismaClient } from "@prisma/client";
import { buildFullStoryFromStructure, parseEpisodeFootage } from "../lib/season";
import { normalizeLanguage } from "../lib/idea";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const projectId = argValue("--project");
  const dryRun = process.argv.includes("--dry-run");
  const prisma = new PrismaClient();
  try {
    const seasons = await prisma.season.findMany({
      where: projectId ? { projectId } : {},
      include: {
        project: { select: { id: true, language: true, synopsis: true } },
        episodes: { orderBy: { number: "asc" }, select: { number: true, title: true, description: true } },
      },
      orderBy: [{ projectId: "asc" }, { number: "asc" }],
    });
    console.log(`${seasons.length} season(s) found${projectId ? ` for project ${projectId}` : ""}${dryRun ? " (dry run)" : ""}`);
    let updated = 0, skipped = 0, unchanged = 0;
    for (const s of seasons) {
      const tag = `project ${s.project.id} season ${s.id} (#${s.number})`;
      if (!s.episodes.length) { console.log(`SKIP ${tag}: no episodes`); skipped++; continue; }
      const bad = s.episodes.filter((e) => !parseEpisodeFootage(e.description));
      if (bad.length) { console.log(`SKIP ${tag}: episodes ${bad.map((e) => e.number).join(", ")} are not in the footage format`); skipped++; continue; }
      const language = normalizeLanguage(s.project.language, s.project.synopsis ?? "");
      const next = buildFullStoryFromStructure({ title: s.title, logline: s.logline, episodes: s.episodes }, language, s.project.synopsis);
      const oldLen = s.fullStory?.length ?? 0;
      if (s.fullStory === next) { console.log(`OK   ${tag}: already in sync (${oldLen} chars)`); unchanged++; continue; }
      if (!dryRun) await prisma.season.update({ where: { id: s.id }, data: { fullStory: next } });
      console.log(`${dryRun ? "PLAN" : "DONE"} ${tag}: fullStory ${oldLen} → ${next.length} chars`);
      updated++;
    }
    console.log(`\nupdated ${updated}, unchanged ${unchanged}, skipped ${skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
