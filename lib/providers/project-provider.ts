import { prisma } from "@/lib/db";
import { isGenerationProvider, type GenerationProvider } from "@/lib/validations";

/** Stage 73: read the project's reference-image provider (defaults to replicate on any failure). */
export async function loadProjectImageProvider(projectId: string): Promise<GenerationProvider> {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { imageProvider: true } }).catch(() => null);
  return isGenerationProvider(row?.imageProvider) ? row.imageProvider : "replicate";
}

/** Stage 73: read the project's scene-video provider (defaults to wavespeed on any failure). */
export async function loadProjectVideoProvider(projectId: string): Promise<GenerationProvider> {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { videoProvider: true } }).catch(() => null);
  return isGenerationProvider(row?.videoProvider) ? row.videoProvider : "wavespeed";
}
