/**
 * Stage 109 — keyframe (and last frame) open in a full-size lightbox from the Scenes tab.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage109.ts
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}
const view = fs.readFileSync(path.join(__dirname, "..", "app/project/[id]/episode/[episodeId]/episode-view.tsx"), "utf8");

// The lightbox lives in episode-view (reused from the reference images) — no second component.
ok(/data-testid="lightbox"/.test(view) && /const \[lightbox, setLightbox\]/.test(view), "episode-view has the shared lightbox state + renderer");
ok(!fs.existsSync(path.join(__dirname, "..", "app/project/[id]/_components/image-lightbox.tsx")), "no duplicate image-lightbox component was added (existing lightbox reused)");

// Keyframe thumbnail opens the lightbox.
const kf = view.slice(view.indexOf('data-testid="scene-keyframe"'), view.indexOf('data-testid="scene-keyframe-badge"'));
ok(/onClick=\{\(\) => openLightbox\(\[scene\.keyframeUrl\]/.test(kf), "keyframe thumbnail click opens the lightbox with the keyframe url");
ok(/aria-label="Open keyframe"/.test(kf), "keyframe open control has aria-label \"Open keyframe\"");
ok(/cursor-zoom-in/.test(kf), "keyframe thumbnail shows a zoom-in cursor");
ok(/<Maximize2 /.test(kf), "keyframe has an expand icon control");
ok(!/group-hover:/.test(kf) && !/hover:opacity/.test(kf) && !/opacity-0/.test(kf), "keyframe open control is NOT hover-only");
ok(/data-testid="scene-keyframe-thumb"/.test(kf), "keyframe thumbnail testid preserved");
ok(/data-testid="scene-keyframe-generate"/.test(view) && /generateKeyframe\(scene\.id\)/.test(view), "keyframe generate/regenerate button untouched");

// Last frame opens the same lightbox.
ok(/openLightbox\(\[scene\.lastFrameUrl\]/.test(view) && /aria-label="Open last frame"/.test(view), "last frame opens in the same lightbox");
ok(/className="relative aspect-\[9\/16\] h-\[420px\][^"]*" data-testid="scene-preview"/.test(view), "scene preview container is relative (anchors the last-frame control)");

// Lightbox behaviour: backdrop click, Esc, X, fitted image, Open original link.
const lb = view.slice(view.indexOf("{lightbox && ("), view.indexOf("{/* Stage 39"));
ok(/onClick=\{\(\) => setLightbox\(null\)\}/.test(lb), "lightbox closes on backdrop click");
ok(/data-testid="lightbox-close"/.test(lb), "lightbox has an X close button");
ok(/e\.key === 'Escape'\) setLightbox\(null\)/.test(view), "lightbox closes on Esc");
ok(/max-h-\[92vh\] max-w-full object-contain/.test(lb), "lightbox image fitted: max-h-[92vh] object-contain");
ok(/bg-black\/95/.test(lb), "lightbox has a dark backdrop");
ok(/target="_blank" rel="noopener noreferrer"[\s\S]{0,200}?data-testid="lightbox-open-original">Open original<\/a>/.test(lb), "lightbox has an \"Open original\" link (new tab, noopener)");

console.log(`Stage 109: ${passed} checks passed`);
