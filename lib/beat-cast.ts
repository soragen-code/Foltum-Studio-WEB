/**
 * Simplified pipeline — cast of a BEAT scene.
 *
 * Beat scenes created by the shot-list job carry their cast as Latin names in `Scene.beatMeta.characters`
 * and often have NO SceneCharacter rows. Every consumer that needs character reference images (start-frame
 * redraw, the video prompt, the prompt previews) falls back to matching those names against the project's
 * Character rows. Pure name matching — nothing is persisted here.
 */
import { prisma } from "@/lib/db";
import { parseBeatMeta } from "@/lib/simple-pipeline";

export type BeatCastCharacter = {
  id: string; name: string; tier: string | null; appearance: string | null; age: string | null; gender: string | null;
  imageFront: string | null; imageProfile: string | null; imageFull: string | null; imageExtra: string | null;
};
export type BeatCastLink = { sceneId: string; characterId: string; character: BeatCastCharacter };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, " ").trim();

/** Match beat character names to project characters: exact full name, then first-token (first name) match. */
export function matchBeatCharacters<T extends { id: string; name: string }>(names: string[], pool: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = norm(String(raw ?? ""));
    if (!n) continue;
    let hit = pool.find((c) => norm(c.name) === n);
    if (!hit) {
      const first = n.split(" ")[0];
      hit = pool.find((c) => norm(c.name).split(" ")[0] === first) ?? pool.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name)));
    }
    if (hit && !seen.has(hit.id)) { seen.add(hit.id); out.push(hit); }
  }
  return out;
}

/**
 * Cast links for a scene: the stored SceneCharacter rows when present; otherwise (beat scene) the project
 * characters matched by the beat's names, shaped like `sceneCharacter.findMany({ include: { character } })`.
 */
export async function resolveBeatCastLinks(scene: { id: string; episodeId: string; beatMeta?: unknown }, existing: BeatCastLink[] | null | undefined): Promise<BeatCastLink[]> {
  if (existing && existing.length) return existing;
  const beat = parseBeatMeta(scene.beatMeta);
  if (!beat || !beat.characters.length) return existing ?? [];
  const ep = await prisma.episode.findUnique({ where: { id: scene.episodeId }, select: { season: { select: { projectId: true } } } });
  if (!ep) return existing ?? [];
  const pool = await prisma.character.findMany({
    where: { projectId: ep.season.projectId },
    select: { id: true, name: true, tier: true, appearance: true, age: true, gender: true, imageFront: true, imageProfile: true, imageFull: true, imageExtra: true },
    orderBy: { createdAt: "asc" },
  });
  return matchBeatCharacters(beat.characters, pool).map((c) => ({ sceneId: scene.id, characterId: c.id, character: c }));
}
