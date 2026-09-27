import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Prompt log — every request sent to the LLM gateway (lib/ai.ts) and to the WaveSpeed image / video
 * generators (image-provider.ts, wavespeed.ts) is recorded, fire-and-forget, into the existing
 * `GenerationLog` table (promptVersion = "prompt-log"; the prompt itself lives in `notes`). No new Prisma
 * model / migration: `notes` is Json.
 *
 * The caller's context (kind + project / episode / scene ids) is carried by an AsyncLocalStorage so the
 * low-level helpers (chat(), wavespeedStart(), wavespeedSubmit()) need no extra parameters: a route or a
 * worker wraps its work in `runWithPromptContext({ kind, projectId, episodeId }, fn)`. NOTE: lib/jobs.ts
 * runInBackground uses Next `after()`, which runs the callback OUTSIDE the request's async context — so the
 * context must be set inside the background function (or at the top of the run*Job worker), not around the
 * runInBackground call.
 */
export interface PromptContext {
  kind?: string;
  projectId?: string;
  seasonId?: string;
  episodeId?: string;
  sceneId?: string;
}

export const PROMPT_LOG_VERSION = "prompt-log";
/** Max characters kept per prompt part so the JSON column never balloons (system prompts can be ~30–50k). */
export const PROMPT_LOG_MAX_CHARS = 60_000;

const storage = new AsyncLocalStorage<PromptContext>();

/** Run `fn` with the given prompt context (merged over any outer context). */
export function runWithPromptContext<T>(ctx: PromptContext, fn: () => T): T {
  const outer = storage.getStore();
  const merged: PromptContext = { ...(outer ?? {}) };
  for (const [k, v] of Object.entries(ctx) as [keyof PromptContext, string | undefined][]) {
    if (v) merged[k] = v;
  }
  return storage.run(merged, fn);
}

/** The current prompt context (empty object when none was set). */
export function getPromptContext(): PromptContext {
  return storage.getStore() ?? {};
}

export interface LogPromptInput {
  kind?: string;
  provider: string;
  endpoint: string;
  model: string;
  system?: string | null;
  user: string;
  extra?: Record<string, unknown> | null;
  projectId?: string | null;
  seasonId?: string | null;
  episodeId?: string | null;
  sceneId?: string | null;
}

function clip(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (text.length <= PROMPT_LOG_MAX_CHARS) return text;
  return `${text.slice(0, PROMPT_LOG_MAX_CHARS)}\n…[truncated ${text.length - PROMPT_LOG_MAX_CHARS} chars]`;
}

/** Strip base64 payloads / oversized strings from `extra` so the row stays small. */
function sanitizeExtra(extra: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!extra) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") {
      if (v.startsWith("data:") || v.length > 2000) { out[k] = `[${v.length} chars omitted]`; continue; }
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === "string" && (x.startsWith("data:") || x.length > 2000) ? `[${x.length} chars omitted]` : x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Fire-and-forget: record one outgoing prompt. Never throws, never blocks the caller (the DB write runs in the
 * background; failures are only console.warn'ed).
 */
export function logPrompt(input: LogPromptInput): void {
  try {
    const ctx = getPromptContext();
    const kind = input.kind ?? ctx.kind ?? "llm";
    const projectId = input.projectId ?? ctx.projectId ?? null;
    const seasonId = input.seasonId ?? ctx.seasonId ?? null;
    const episodeId = input.episodeId ?? ctx.episodeId ?? null;
    const sceneId = input.sceneId ?? ctx.sceneId ?? null;
    const notes = {
      provider: input.provider,
      endpoint: input.endpoint,
      system: clip(input.system),
      user: clip(input.user) ?? "",
      sceneId,
      extra: sanitizeExtra(input.extra),
    };
    void prisma.generationLog
      .create({
        data: {
          projectId,
          seasonId,
          episodeId,
          kind,
          model: input.model,
          promptVersion: PROMPT_LOG_VERSION,
          attempts: 1,
          accepted: true,
          notes: notes as unknown as Prisma.InputJsonObject,
        },
      })
      .catch((err: unknown) => {
        console.warn(`[prompt-log] failed to write ${kind}/${input.provider}:`, err instanceof Error ? err.message : err);
      });
  } catch (err) {
    console.warn("[prompt-log] logPrompt error:", err instanceof Error ? err.message : err);
  }
}
