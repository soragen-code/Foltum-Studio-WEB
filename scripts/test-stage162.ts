/**
 * Stage 162 — Location rows are generated PER EPISODE from that episode's FINISHED shooting script (not all
 * up front from the synopsis). The extraction/reuse/binding logic lives in the PURE function
 * planEpisodeLocations (lib/season.ts) so it is unit-testable with no DB.
 *
 * Pure-logic unit test (no network, no DB, no paid generation). Verifies:
 *   (1) DISTINCT extraction — distinct location NAMES are pulled from the scene descriptors in order.
 *   (2) REUSE / no-duplicate — a name already present among the project's existing locations is reused
 *       (never listed in `create`), and its stored NAME (not the raw script text) wins in the binding.
 *   (3) CROSS-EPISODE dedupe — a location created for an earlier episode (fed back in as `existing`) is
 *       reused by the next episode, not re-created.
 *   (4) SCENE → LOCATION binding — every scene is bound to its own location by name.
 *   (5) SINGLE-LOCATION (auto) episode — one distinct location; it is created once and binds ALL scenes,
 *       and is the episode's primary location.
 */
import { planEpisodeLocations, distinctSceneLocationNames } from "../lib/season";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok: ${msg}`);
}

// ── (1) DISTINCT extraction ───────────────────────────────────────────────────────────────────────
{
  const scenes = [
    { id: "s1", locationDesc: "INT — Security office — day" },
    { id: "s2", locationDesc: "INT — Security office — night" }, // same place, different time → one name
    { id: "s3", locationDesc: "EXT — Rooftop — dusk" },
    { id: "s4", locationDesc: "" }, // no usable place → contributes nothing
  ];
  const names = distinctSceneLocationNames(scenes);
  ok(names.length === 2, "(1) distinct extraction yields 2 distinct location names");
  ok(names[0] === "Security office" && names[1] === "Rooftop", "(1) distinct names are in scene order, time-of-day stripped");

  const plan = planEpisodeLocations(scenes, []);
  ok(plan.names.length === 2 && plan.create.length === 2, "(1) with no existing locations, both distinct names are created");
  ok(plan.primaryName === "Security office", "(1) primary location is the first distinct name");
}

// ── (2) REUSE / no-duplicate ──────────────────────────────────────────────────────────────────────
{
  const existing = [{ id: "loc-sec", name: "Security office" }];
  const scenes = [
    { id: "s1", locationDesc: "INT — security OFFICE — day" }, // case-insensitive match to the existing row
    { id: "s2", locationDesc: "EXT — Alley — night" },
  ];
  const plan = planEpisodeLocations(scenes, existing);
  ok(plan.create.length === 1 && plan.create[0].name === "Alley", "(2) only the unknown location (Alley) is created; the existing one is reused");
  ok(!plan.create.some((c) => c.name.toLowerCase() === "security office"), "(2) the existing location is NOT duplicated in create");
  const secBinding = plan.bindings.find((b) => b.sceneId === "s1");
  ok(!!secBinding && secBinding.locationName === "Security office", "(2) reused binding uses the existing row's stored NAME, not the raw script text");
}

// ── (3) CROSS-EPISODE dedupe ──────────────────────────────────────────────────────────────────────
{
  // Episode 1 creates "Warehouse". We feed it back as an existing location for episode 2.
  const ep1 = planEpisodeLocations([{ id: "a1", locationDesc: "INT — Warehouse — day" }], []);
  ok(ep1.create.length === 1 && ep1.create[0].name === "Warehouse", "(3) episode 1 creates Warehouse");
  const existingAfterEp1 = [{ id: "loc-wh", name: "Warehouse" }];
  const ep2 = planEpisodeLocations(
    [
      { id: "b1", locationDesc: "INT — Warehouse — night" }, // reuse across episodes
      { id: "b2", locationDesc: "EXT — Docks — dawn" }, // new for episode 2
    ],
    existingAfterEp1,
  );
  ok(ep2.create.length === 1 && ep2.create[0].name === "Docks", "(3) episode 2 reuses Warehouse and only creates Docks");
}

// ── (4) SCENE → LOCATION binding ──────────────────────────────────────────────────────────────────
{
  const scenes = [
    { id: "s1", locationDesc: "INT — Kitchen — day" },
    { id: "s2", locationDesc: "INT — Bedroom — day" },
    { id: "s3", locationDesc: "INT — Kitchen — night" }, // back to the first place
  ];
  const plan = planEpisodeLocations(scenes, []);
  ok(plan.bindings.length === 3, "(4) every scene is bound");
  const byScene = new Map(plan.bindings.map((b) => [b.sceneId, b.locationName]));
  ok(byScene.get("s1") === "Kitchen" && byScene.get("s3") === "Kitchen", "(4) both Kitchen scenes bind to the same location name");
  ok(byScene.get("s2") === "Bedroom", "(4) the Bedroom scene binds to Bedroom");
}

// ── (5) SINGLE-LOCATION (auto) episode ──────────────────────────────────────────────────────────────
{
  const scenes = [
    { id: "s1", locationDesc: "The abandoned lighthouse" },
    { id: "s2", locationDesc: "The abandoned lighthouse" },
    { id: "s3", locationDesc: "The abandoned lighthouse" },
  ];
  const plan = planEpisodeLocations(scenes, []);
  ok(plan.names.length === 1 && plan.create.length === 1, "(5) a single-location (auto) episode creates exactly one location");
  ok(plan.bindings.length === 3 && plan.bindings.every((b) => b.locationName === "The abandoned lighthouse"), "(5) the one location binds all scenes");
  ok(plan.primaryName === "The abandoned lighthouse", "(5) it is the episode's primary location");
}

console.log(`Stage 162: PASS (${passed} checks; pure logic, no network, no paid generation)`);
