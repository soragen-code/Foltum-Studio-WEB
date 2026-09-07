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

export const acceptSceneSchema = z.object({
  sceneId: cuidSchema,
});

export const assembleEpisodeSchema = z.object({
  episodeId: cuidSchema,
});

/* ------------------------------------------------------------------ */
/*  Projects                                                           */
/* ------------------------------------------------------------------ */

export const createProjectSchema = z.object({
  name: z
    .string({ required_error: "Project name is required" })
    .trim()
    .min(1, "Project name is required")
    .max(200, "Project name must be at most 200 characters"),
  tier: z.enum(["minimum", "medium", "maximum"]).optional().nullable(),
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
