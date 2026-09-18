/**
 * Stage 163 — the chain must NEVER skip ahead. `nextSequentialChainScene` always returns the
 * lowest-numbered scene that still needs a video, has a prompt and is idle — so an out-of-order
 * completion (a later scene finishing while an earlier one is ungenerated) can never leave a
 * permanent gap like {1,3,4,6}. This mirrors the strict selection the cron sweeper already uses via
 * `chainSceneToResume`. Pure logic only — no DB, no network, no paid generation.
 */
import { nextSequentialChainScene, nextChainScene, chainSceneToResume, type ChainSceneLike } from "@/lib/chain-run";

let checks = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  checks++;
}

const P = "x".repeat(60); // a valid (>=40 char) prompt

type S = ChainSceneLike & { number: number };
const gen = (number: number): S => ({ id: `s${number}`, number, videoUrl: `http://v/${number}.mp4`, videoPrompt: P, status: "generated" });
const pending = (number: number): S => ({ id: `s${number}`, number, videoUrl: null, videoPrompt: P, status: "pending" });
const generating = (number: number): S => ({ id: `s${number}`, number, videoUrl: null, videoPrompt: P, status: "generating" });
const noPrompt = (number: number): S => ({ id: `s${number}`, number, videoUrl: null, videoPrompt: "", status: "pending" });

// 1) THE CORE REGRESSION — exactly the reported {1,3,4,6} incident: scenes 2 and 5 ungenerated,
//    scene 6 just finished. The next scene chosen MUST be 2 (the lowest gap), NOT 5 or null.
{
  const scenes = [gen(1), pending(2), gen(3), gen(4), pending(5), gen(6)];
  const next = nextSequentialChainScene(scenes);
  ok(next?.number === 2, "reported {1,3,4,6}: fills scene 2 first (never skips to 5/nothing)");
  // and after 2 is done, it fills 5 — full recovery to a complete prefix.
  const scenes2 = [gen(1), gen(2), gen(3), gen(4), pending(5), gen(6)];
  ok(nextSequentialChainScene(scenes2)?.number === 5, "then fills scene 5 — gap fully recovered");
  const scenesDone = [gen(1), gen(2), gen(3), gen(4), gen(5), gen(6)];
  ok(nextSequentialChainScene(scenesDone) === null, "all generated → chain ends (null)");
}

// 2) Selection is independent of which scene just finished (no `afterNumber` cursor anymore):
//    even if scene 3 finished while 2 is still ungenerated, the next scene is 2, not 4.
{
  const scenes = [gen(1), pending(2), gen(3), pending(4)];
  ok(nextSequentialChainScene(scenes)?.number === 2, "out-of-order finish: picks lowest gap (2), not 4");
  // Contrast: the legacy afterNumber path WOULD skip 2 — this is the bug we removed.
  ok(nextChainScene(scenes, 3)?.number === 4, "legacy nextChainScene(after=3) skips to 4 (documented old behavior)");
}

// 3) Strict prefix growth 1→2→3→… from an empty episode.
{
  const scenes = [pending(1), pending(2), pending(3)];
  ok(nextSequentialChainScene(scenes)?.number === 1, "empty episode → starts at scene 1");
  ok(nextSequentialChainScene([gen(1), pending(2), pending(3)])?.number === 2, "after 1 → scene 2");
  ok(nextSequentialChainScene([gen(1), gen(2), pending(3)])?.number === 3, "after 2 → scene 3");
}

// 4) Never double-start: if the earliest ungenerated scene is already generating, return null.
{
  const scenes = [gen(1), generating(2), pending(3)];
  ok(nextSequentialChainScene(scenes) === null, "earliest ungenerated is generating → do not start anything");
}

// 5) A promptless earliest scene is not in the chain (real episodes always have prompts; this matches
//    nextChainScene's long-standing behavior): the next real chain scene is the lowest PROMPTED gap.
{
  const scenes = [gen(1), noPrompt(2), pending(3)];
  ok(nextSequentialChainScene(scenes)?.number === 3, "promptless scene skipped for prompted scene 3 (unchanged rule)");
}

// 6) Consistency with the sweeper: for an active chain, nextSequentialChainScene and chainSceneToResume
//    agree on the target when it is idle (both strict, both lowest-ungenerated-prompted).
{
  const scenes = [gen(1), pending(2), gen(3), pending(4), pending(5), gen(6)];
  const seq = nextSequentialChainScene(scenes);
  const swept = chainSceneToResume({ chainRunActive: true, scenes });
  ok(seq?.number === 2 && swept?.number === 2, "server chain and cron sweeper agree on the lowest gap (2)");
}

console.log(`\nStage 163: PASS (${checks} checks)`);
