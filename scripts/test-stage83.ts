/**
 * Stage 83 — rewriting the episode plot/synopsis/script resets all scenes; confirm first when scenes exist.
 *
 * Covered:
 *  (1) pure gate helper `needsSceneResetConfirm` + exact Russian confirm copy;
 *  (2) episode-view wiring: sticky «Переписать» → askReviseEpisode → gate → confirm dialog (Да/Отмена),
 *      confirm runs the rewrite with force=true (single, destructive reset);
 *  (3) per-scene «Изменить»/«Перегенерировать» stay instant with NO confirmation (Stage 79a preserved).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENE_RESET_CONFIRM_MESSAGE, needsSceneResetConfirm } from "../lib/scene-reset-confirm";

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL: " + label); process.exit(1); }
  console.log("ok: " + label);
  passed++;
}

const ROOT = join(__dirname, "..");
const view = readFileSync(join(ROOT, "app/project/[id]/episode/[episodeId]/episode-view.tsx"), "utf8");
const helper = readFileSync(join(ROOT, "lib/scene-reset-confirm.ts"), "utf8");

// ---- (1) pure gate helper ---------------------------------------------------
ok("1: gate false when there are no scenes", needsSceneResetConfirm(0) === false);
ok("1: gate false for null/undefined scene count", needsSceneResetConfirm(null) === false && needsSceneResetConfirm(undefined) === false);
ok("1: gate true when scenes exist (1)", needsSceneResetConfirm(1) === true);
ok("1: gate true when scenes exist (many)", needsSceneResetConfirm(12) === true);
ok(
  "1: confirm copy is the exact Russian text with Продолжить?",
  SCENE_RESET_CONFIRM_MESSAGE === "Изменение сюжета/синопсиса/сценария сбросит все текущие сцены и их промпты. Продолжить?",
);
ok("1: helper documents that per-scene buttons stay instant", /Stage 79a/.test(helper) && /instant/.test(helper));

// ---- (2) episode-view wiring ------------------------------------------------
ok("2: view imports the gate helper", /from '@\/lib\/scene-reset-confirm'/.test(view) && /needsSceneResetConfirm/.test(view) && /SCENE_RESET_CONFIRM_MESSAGE/.test(view));
ok("2: a resetAsk state gates the confirm dialog", /const \[resetAsk, setResetAsk\] = useState\(false\)/.test(view));
ok("2: askReviseEpisode uses the gate before rewriting", /const askReviseEpisode = \(\) => \{[\s\S]*?needsSceneResetConfirm\(scenes\.length\)[\s\S]*?setResetAsk\(true\); return[\s\S]*?void reviseEpisode\(\)/.test(view));
ok("2: no scenes → rewrite runs immediately (void reviseEpisode() with no force)", /void reviseEpisode\(\)\n\s*\}/.test(view));
ok("2: confirm runs the destructive rewrite with force=true", /const confirmReviseReset = \(\) => \{ setResetAsk\(false\); void reviseEpisode\(true\) \}/.test(view));
ok("2: sticky «Переписать» bar submits through the gate, not straight to reviseEpisode", /onSubmit=\{askReviseEpisode\}/.test(view) && !/onSubmit=\{\(\) => reviseEpisode\(\)\}/.test(view));
ok("2: confirm dialog is rendered only in script phase when resetAsk is set", /phase === 'script' && resetAsk &&/.test(view));
ok("2: dialog shows the exact confirm copy constant", /\{SCENE_RESET_CONFIRM_MESSAGE\}/.test(view));
ok("2: dialog has a Да button wired to confirmReviseReset", /onClick=\{confirmReviseReset\}[^>]*data-testid="scene-reset-yes"[\s\S]*?Да<\/button>/.test(view) || /data-testid="scene-reset-yes"[\s\S]*?Да/.test(view));
ok("2: dialog has an Отмена button that only closes the dialog (no change)", /onClick=\{\(\) => setResetAsk\(false\)\}[^>]*data-testid="scene-reset-cancel"[\s\S]*?Отмена/.test(view));
ok("2: dialog carries a stable testid", /data-testid="scene-reset-confirm"/.test(view));

// ---- (3) per-scene actions stay instant (Stage 79a preserved) ---------------
// reviseScene must NOT open any confirmation — it revises + re-renders the clip in one shot.
const reviseSceneBlock = view.slice(view.indexOf("const reviseScene ="), view.indexOf("const undoScene ="));
ok("3: reviseScene body present", reviseSceneBlock.length > 0);
ok("3: reviseScene does not open the reset dialog", !/setResetAsk/.test(reviseSceneBlock));
ok("3: reviseScene does not use a browser confirm()", !/\bconfirm\(/.test(reviseSceneBlock));
ok("3: reviseScene still auto-regenerates the clip immediately (Stage 79a)", /await regenScene\(scene\.id\)/.test(reviseSceneBlock));
ok("3: per-scene «Перегенерировать» button keeps its instant title (no confirmation)", /title="Перегенерировать ролик сразу, без подтверждения"/.test(view));
ok("3: reset gate is scoped to episode rewrite, not per-scene (regenScene never opens the dialog)", !/regenScene[\s\S]{0,80}setResetAsk/.test(view));

console.log(`\nStage 83: ${passed} checks passed`);
