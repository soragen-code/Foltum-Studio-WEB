/**
 * Stage 40 — chain generation mode («По цепочке»), pure helpers (DB-free, unit-tested).
 *
 * `Episode.chainMode`:
 *   - "parallel" (default, Stage 39): «Сгенерировать все» starts every scene at once; scenes are
 *     joined through the screenwriter's scripted `endState` (OPENING STATE of the next scene).
 *   - "chain": scenes are generated strictly one after another. After each finished scene its last
 *     frame is described by a vision model (`Scene.endStateActual`) and that description opens the
 *     prompt of the next scene. Credits are charged per scene when the scene actually starts. On the
 *     first failure the chain stops and the episode keeps a note (`Episode.chainRunNote`).
 */

export type ChainMode = "parallel" | "chain";
export const CHAIN_MODES: readonly ChainMode[] = ["parallel", "chain"];

export function isChainMode(value: unknown): value is ChainMode {
  return value === "parallel" || value === "chain";
}

export function normalizeChainMode(value: unknown): ChainMode {
  return value === "chain" ? "chain" : "parallel";
}

export interface ChainSceneLike {
  id: string;
  number: number;
  videoUrl?: string | null;
  videoPrompt?: string | null;
  status?: string | null;
}

/**
 * The next scene to start in a chain run: the lowest-numbered scene that has a prompt, has no video
 * yet and is not already generating. `afterNumber` restricts the search to scenes after the one that
 * just finished (so a re-generated middle scene never re-runs earlier scenes).
 */
export function nextChainScene<S extends ChainSceneLike>(scenes: readonly S[], afterNumber = 0): S | null {
  const sorted = [...scenes].sort((a, b) => a.number - b.number);
  for (const s of sorted) {
    if (s.number <= afterNumber) continue;
    if (!(s.videoPrompt ?? "").trim()) continue;
    if (s.videoUrl) continue;
    if (s.status === "generating") continue;
    return s;
  }
  return null;
}

/** Ordered list of the scenes a chain run will go through (for the confirmation modal / tests). */
export function chainOrder<S extends ChainSceneLike>(scenes: readonly S[]): S[] {
  const out: S[] = [];
  let after = 0;
  for (;;) {
    const next = nextChainScene(scenes, after);
    if (!next) return out;
    out.push(next);
    after = next.number;
  }
}

/** Russian note stored on the episode when the chain stops because a scene failed. */
export function chainStopMessage(sceneNumber: number, error: string): string {
  const reason = (error ?? "").trim() || "неизвестная ошибка";
  return `Цепочка остановлена на сцене ${sceneNumber}: ${reason}`;
}

export const CHAIN_INSUFFICIENT_CREDITS = "недостаточно кредитов";

/**
 * Human hint for the mode toggle (UI). Kept here so the wording is a single source of truth.
 */
export const CHAIN_MODE_HINTS: Record<ChainMode, string> = {
  parallel: "Параллельно: все сцены стартуют сразу. Стыковка между сценами — по сценарному описанию финального кадра предыдущей сцены («Финал кадра»).",
  chain: "По цепочке: сцены идут строго по очереди. После каждой готовой сцены её последний кадр описывается моделью, и это описание попадает в начало промпта следующей сцены. Кредиты списываются за каждую сцену при её старте; при ошибке цепочка останавливается.",
};
