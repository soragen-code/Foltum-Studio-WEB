/**
 * Stage 46E — server-side lookup of the reference frames a user may download.
 * The download proxy never fetches arbitrary URLs: the URL must be one of the frames stored on a
 * Character / Location of a project the user owns.
 */
import { prisma } from "@/lib/db";
import { parseImageArray } from "@/lib/reference-counts";
import { parseLocationExtra } from "@/lib/visual-style";
import { referenceFileName } from "@/lib/download-name";

export interface OwnedFrame {
  kind: "character" | "location";
  name: string;
  slot: string;
  index?: number;
  url: string;
  fileName: string;
}

function valid(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** All valid frames of a character (front, profile, full, extras) with their download names. */
export function characterFrames(c: { name: string; imageFront: string | null; imageProfile: string | null; imageFull: string | null; imageExtra: string | null }): OwnedFrame[] {
  const out: OwnedFrame[] = [];
  const base: Array<[string, string | null]> = [["front", c.imageFront], ["profile", c.imageProfile], ["full", c.imageFull]];
  for (const [slot, url] of base) if (valid(url)) out.push({ kind: "character", name: c.name, slot, url, fileName: referenceFileName("character", c.name, slot, url) });
  parseImageArray(c.imageExtra).forEach((url, i) => { if (valid(url)) out.push({ kind: "character", name: c.name, slot: "extra", index: i, url, fileName: referenceFileName("character", c.name, "extra", url, i) }); });
  return out;
}

/** All valid frames of a location (master, layout, detail, extras). Stage 111: imageReverse holds the elevated layout view. */
export function locationFrames(l: { name: string; imageUrl: string | null; imageReverse: string | null; imageDetail: string | null; imageExtra: string | null }): OwnedFrame[] {
  const out: OwnedFrame[] = [];
  const base: Array<[string, string | null]> = [["master", l.imageUrl], ["layout", l.imageReverse], ["detail", l.imageDetail]];
  for (const [slot, url] of base) if (valid(url)) out.push({ kind: "location", name: l.name, slot, url, fileName: referenceFileName("location", l.name, slot, url) });
  parseLocationExtra(l.imageExtra).forEach((url, i) => { if (valid(url)) out.push({ kind: "location", name: l.name, slot: "extra", index: i, url, fileName: referenceFileName("location", l.name, "extra", url, i) }); });
  return out;
}

/** Find the frame with exactly this URL among the user's characters / locations (null when not owned). */
export async function findOwnedFrameByUrl(userId: string, url: string): Promise<OwnedFrame | null> {
  const owner = { project: { userId } };
  const char = await prisma.character.findFirst({
    where: { ...owner, OR: [{ imageFront: url }, { imageProfile: url }, { imageFull: url }, { imageExtra: { contains: url } }] },
    select: { name: true, imageFront: true, imageProfile: true, imageFull: true, imageExtra: true },
  });
  if (char) {
    const f = characterFrames(char).find((x) => x.url === url);
    if (f) return f;
  }
  const loc = await prisma.location.findFirst({
    where: { ...owner, OR: [{ imageUrl: url }, { imageReverse: url }, { imageDetail: url }, { imageExtra: { contains: url } }] },
    select: { name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true },
  });
  if (loc) {
    const f = locationFrames(loc).find((x) => x.url === url);
    if (f) return f;
  }
  return null;
}
