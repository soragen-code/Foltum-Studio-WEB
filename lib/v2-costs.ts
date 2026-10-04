/**
 * Стоимость шагов потока v2 в кредитах — единый источник правды для сервера (списание в POST-роутах
 * /api/ai/v2/*) и клиента (сумма на кнопке «Сгенерировать»). Файл без серверных зависимостей — безопасно
 * импортировать в клиентские компоненты.
 *
 * Ставки (кредит = единица пакетов WayForPay, см. lib/wayforpay.ts; совпадают с ручным режимом
 * MANUAL_PHOTO_COST = 10 / MANUAL_VIDEO_COST_PER_SEC = 10). Деноминация ×10: 10 кредитов = 1 секунда видео.
 *   LLM-текст (синопсис, сюжет сезона, сценарий серии, разбивка на кадры, извлечение референсов) — по 10 кредитов за запуск;
 *   картинка референса — 10 за каждую; лист сториборда — 30; первый кадр сцены — 10 за каждую сцену (кадр);
 *   видео сцены — 10 за секунду (длительность шота, зажатая в [4, 30], как в воркере Seedance); склейка серии (ffmpeg) — бесплатна, но
 *   сборка серии — 10 кредитов: один фоновый музыкальный трек ACE-Step 1.5 на всю серию + LLM-подбор настроения.
 */
export const V2_COSTS = {
  logline: 10,
  synopsis: 10,
  plot: 10,
  script: 10,
  shots: 10,
  refsExtract: 10,
  refImage: 10,
  storyboard: 30,
  sceneFrame: 10,
  sceneVideoPerSec: 10,
  assemble: 10,
} as const;

/** Стоимость «Собрать эпизод»: один трек фоновой музыки на серию (генерация + подбор настроения). */
export function assembleCost(): number {
  return V2_COSTS.assemble;
}

/** Те же границы, что SEEDANCE_I2V_MIN/MAX_DURATION в lib/wavespeed.ts (дублируем, чтобы файл оставался клиентским). */
export const V2_SCENE_VIDEO_MIN_SEC = 4;
export const V2_SCENE_VIDEO_MAX_SEC = 30;

export function sceneVideoSeconds(durationSec: number | undefined | null): number {
  const raw = Number.isFinite(Number(durationSec)) ? Math.round(Number(durationSec)) : 5;
  return Math.max(V2_SCENE_VIDEO_MIN_SEC, Math.min(V2_SCENE_VIDEO_MAX_SEC, raw));
}

/** Стоимость картинок референсов: по одной на каждый выбранный референс. */
export function refImagesCost(count: number): number {
  return Math.max(0, count) * V2_COSTS.refImage;
}

/** Стоимость нарезки первых кадров после подтверждения сториборда: по кадру на каждый шот. */
export function sceneFramesCost(shotsCount: number): number {
  return Math.max(0, shotsCount) * V2_COSTS.sceneFrame;
}

type SceneLike = { firstFrameUrl?: string | null; videoStatus?: string | null; durationSec?: number | null };

/**
 * Сцены, которые возьмёт «Запустить все сцены»: та же логика, что в воркере episode-scene-video-v2-job —
 * сцены с первым кадром; из них ещё не готовые (videoStatus !== "done"), а если готовы все — все заново.
 */
export function chooseSceneVideoTargets<T extends SceneLike>(scenes: T[]): T[] {
  const withFrame = scenes.filter((s) => !!s.firstFrameUrl);
  const pending = withFrame.filter((s) => s.videoStatus !== "done");
  return pending.length ? pending : withFrame;
}

/** Стоимость «Запустить все сцены»: Σ секунд видео выбранных сцен × ставка за секунду. */
export function sceneVideosCost(scenes: SceneLike[]): number {
  return chooseSceneVideoTargets(scenes).reduce((sum, s) => sum + sceneVideoSeconds(s.durationSec) * V2_COSTS.sceneVideoPerSec, 0);
}
