import { z } from "zod";
import { badRequest } from "@/lib/api-errors";

/* ------------------------------------------------------------------ */
/*  Primitives                                                         */
/* ------------------------------------------------------------------ */

/** Prisma cuid() ids: "c" + 24 lowercase alphanumerics */
export const cuidSchema = z
  .string({ required_error: "ID is required", invalid_type_error: "ID must be a string" })
  .regex(/^c[a-z0-9]{20,32}$/, "Invalid ID format");

export const emailSchema = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .email("Invalid email address")
  .max(254, "Email is too long");

export const passwordSchema = z
  .string({ required_error: "Password is required" })
  .min(6, "Password must be at least 6 characters")
  .max(100, "Password must be at most 100 characters");

/* ------------------------------------------------------------------ */
/*  Auth                                                               */
/* ------------------------------------------------------------------ */

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(100, "Name must be at most 100 characters").optional().nullable(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: "Password is required" }).min(1, "Password is required").max(100),
});

/* ------------------------------------------------------------------ */
/*  AI routes                                                          */
/* ------------------------------------------------------------------ */

export const generateVideoSchema = z.object({
  projectId: cuidSchema,
  sceneId: cuidSchema,
  language: z.enum(["en", "ru"]).optional().nullable(),
  /**
   * Legacy video provider field. Stage 33: only Seedance 2.5 exists, so the value is accepted for
   * backward compatibility (old clients may still send it) and ignored — any string passes.
   */
  provider: z.string().max(64).optional().nullable(),
});

export const charactersSchema = z.object({
  projectId: cuidSchema,
  synopsis: z.string().max(20_000).optional().nullable(),
});

export const scenesSchema = z.object({
  projectId: cuidSchema.optional().nullable(),
  episodeId: cuidSchema,
});

export const synopsisSchema = z.object({
  projectId: cuidSchema,
  prompt: z.string().max(10_000).optional().nullable(),
  correction: z.string().max(10_000).optional().nullable(),
  currentSynopsis: z.string().max(20_000).optional().nullable(),
});

export const structureSchema = z.object({
  projectId: cuidSchema,
  synopsis: z.string().max(20_000).optional().nullable(),
  totalDurationMinutes: z.coerce.number().min(1).max(600).optional().nullable(),
});

/* Stage 1 (new flow) */
export const ideaSchema = z
  .object({
    projectId: cuidSchema,
    // Manual mode: the producer's own idea. Optional when auto=true.
    idea: z.string().trim().max(10_000).optional(),
    // Auto mode: the AI invents the story from the chosen genre(s).
    auto: z.boolean().optional().default(false),
    genres: z.array(z.string().trim().min(1).max(60)).max(10).optional().default([]),
    extras: z.string().trim().max(2_000).optional().default(""),
    // Stage 12 — story mode: a finished story uploaded as a file and parsed to text on the server.
    fromStory: z.boolean().optional().default(false),
    story: z.string().trim().max(60_000).optional(),
    // Stage 14 (B) — producer-chosen episode count (manual/auto modes). 3..12; omitted = AI decides.
    episodeCount: z.coerce.number().int().min(3).max(12).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.fromStory) {
      if (!val.story || val.story.trim().length < 20) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["story"], message: "Uploaded story is too short" });
      }
    } else if (val.auto) {
      if (!val.genres || val.genres.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["genres"], message: "Pick at least one genre" });
      }
    } else if (!val.idea || val.idea.trim().length < 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["idea"], message: "Idea is too short" });
    }
  });

export const ideaReviseSchema = z.object({
  projectId: cuidSchema,
  instruction: z.string().trim().min(2, "Instruction is required").max(4_000),
});

export const characterReviseSchema = z.object({
  characterId: cuidSchema,
  instruction: z.string().trim().min(2, "Instruction is required").max(4_000),
});

export const charactersAddSchema = z.object({
  projectId: cuidSchema,
  hint: z.string().trim().max(2_000).optional().default(""),
});

export const charactersReferencesSchema = z.object({
  projectId: cuidSchema,
  tiers: z.array(z.enum(["MAIN", "SUPPORTING", "MINOR", "CROWD"])).optional(),
  characterIds: z.array(cuidSchema).max(100).optional(),
  /** Producer-picked image model (see lib/ai-models.ts). Currently only "seedream-5-lite". */
  imageModel: z.string().max(60).optional().nullable(),
});

export const locationCreateSchema = z.object({
  projectId: cuidSchema,
  name: z.string().trim().min(2).max(120),
  note: z.string().trim().max(2_000).optional().default(""),
});

export const locationReviseBodySchema = z.object({
  instruction: z.string().trim().min(2, "Instruction is required").max(4_000),
  regenerate: z.boolean().optional().default(true),
});

export const acceptSceneSchema = z.object({
  sceneId: cuidSchema,
});

export const assembleEpisodeSchema = z.object({
  episodeId: cuidSchema,
  // Stage 46B: production quality / fps of the FINAL file (defaults 480p / 30 — no re-encode).
  quality: z.enum(["480p", "720p", "1080p"]).optional(),
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
});

/* ------------------------------------------------------------------ */
/*  Projects                                                           */
/* ------------------------------------------------------------------ */

export const createProjectSchema = z.object({
  /** Stage 40: optional — the name is generated from the plot later (idea / test-scene step). */
  name: z
    .string()
    .trim()
    .max(200, "Project name must be at most 200 characters")
    .optional()
    .nullable(),
  tier: z.enum(["minimum", "medium", "maximum"]).optional().nullable(),
  /** New flow: power tier. When present it wins over `tier`. */
  powerTier: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().nullable(),
  synopsis: z.string().max(20_000).optional().nullable(),
  description: z.string().max(5_000).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Turn a ZodError into a single human-readable message: "field: message; field2: message" */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

export type ParseResult<T> = { ok: true; data: T; response?: undefined } | { ok: false; data?: undefined; response: Response };

/**
 * Parse the JSON body of a request with a Zod schema.
 * Returns either the typed data or a ready-to-return 400 response.
 *
 *   const parsed = await parseBody(request, signupSchema);
 *   if (!parsed.ok) return parsed.response;
 *   const { email, password } = parsed.data;
 */
export async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<ParseResult<z.infer<T>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body") };
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, response: badRequest(formatZodError(result.error)) };
  }
  return { ok: true, data: result.data };
}
