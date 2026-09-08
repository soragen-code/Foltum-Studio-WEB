export const dynamic = "force-dynamic";
export const maxDuration = 300; // a 12-shot breakdown with detailed 9-line video prompts is a long LLM completion
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, scenesSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";

import { VISUAL_STYLE } from "@/lib/visual-style";

const EPISODE_MIN_SECONDS = Number(process.env.EPISODE_MIN_SECONDS ?? 60);
// Seedance 2.5 renders one scene = one ~5 s clip. To reach ~1 minute per episode
// (and NEVER less), we need enough scenes to cover EPISODE_MIN_SECONDS at 5 s each.
const SCENE_SECONDS = Number(process.env.SCENE_SECONDS ?? 5);
const SCENES_PER_EPISODE = Number(
  process.env.SCENES_PER_EPISODE ?? Math.ceil(EPISODE_MIN_SECONDS / SCENE_SECONDS)
);

/** Minimum number of purely visual beats (no spoken lines) per episode. */
const MIN_SILENT_SCENES = 2;
/** Maximum silent shots — kept low so the MAJORITY of shots carry spoken dialogue
 *  and characters actually talk to each other across the episode. */
const MAX_SILENT_SCENES = Math.max(MIN_SILENT_SCENES, Math.floor(SCENES_PER_EPISODE / 4));

/** A talking scene is NOT rendered as a ${SCENE_SECONDS}s clip — video generation
 *  stretches each spoken clip to ~10–15 s (Seedance native audio 15 s, Kling 10 s),
 *  which comfortably fits a real 2–3 line exchange. Size the dialogue to THIS. */
const DIALOGUE_CLIP_SECONDS = 12;

const SYSTEM = `You are a film director + cinematographer + editor working on a short-form VERTICAL drama series (9:16, TikTok/Reels format). Every episode must run AT LEAST ${EPISODE_MIN_SECONDS} seconds of screen time.

VISUAL TREATMENT FOR ALL NEW SHOTS: ${VISUAL_STYLE}
Preserve each character's own identity and story; never imitate a studio or franchise. Use only dialogue and natural ambience, never music.

THE CORE IDEA — SCENES ARE SHOTS, NOT MINI-STORIES:
An episode is ONE continuous piece of cinema. The ${SCENES_PER_EPISODE} "scenes" you write are ${SCENES_PER_EPISODE} CAMERA SHOTS (cuts) of ~${SCENE_SECONDS} seconds each inside that single continuous sequence — exactly the way a film editor cuts between angles of the same unfolding action. Each shot is rendered as a separate ~${SCENE_SECONDS} s AI video clip and the clips are concatenated in order, so the viewer must experience them as ONE flowing film, never as unrelated clips glued together.

Given the project synopsis, this episode's description, and the characters, return ONLY valid JSON in this exact shape:

{
  "visualIdentity": "One sentence, English. The cinematic look of the whole episode: cinematography, lighting, color grade, aspect. Use the VISUAL TREATMENT above, with a consistent lighting and color palette.",
  "characterSheet": {
    "CHARACTER_NAME": "Exact physical description used VERBATIM in every videoPrompt where this character appears. Example: 'YARA (early 20s, short black hair, olive skin, dark grey hoodie, silver stud earrings)'"
  },
  "scenes": [
    {
      "number": 1,
      "shotType": "Wide establishing shot | Wide shot | Medium shot | Close-up | Extreme close-up | Over-the-shoulder | POV | Tracking shot | Reaction shot | Insert",
      "dialogue": "[NO DIALOGUE]  — or —  a short back-and-forth EXCHANGE with a delivery cue in parentheses on each line:\\nCHARACTER_NAME (low, guarded): \\"Short line.\\"\\nCHARACTER2 (a tired sigh, barely a whisper): \\"Short reply.\\"\\nCHARACTER_NAME (leaning in): \\"One more beat.\\"",
      "locationDesc": "INT/EXT — Location — Time. Vivid, filmable description of the setting, HOW the light falls (source, direction, quality, shadows, colour temperature) and the atmosphere/ambience.",
      "videoPrompt": "[SHOT TYPE]: ...\\n[VISUAL STYLE]: ...\\n[LIGHTING]: ...\\n[BLOCKING]: ...\\n[GAZE]: ...\\n[NON-VERBAL]: ...\\n[ACTION]: ...\\n[CHARACTER]: ...\\n[TRANSITION]: ..."
    }
  ]
}

============ SHOT DESIGN RULES ============

1. ESTABLISHING SHOT FIRST. Scene 1 of EVERY episode is a wide or aerial ESTABLISHING SHOT (EXT — Location — Time, or a wide interior) that grounds the viewer in place, time and mood, and defines the episode's visual identity. Brief or NO dialogue in scene 1 (prefer [NO DIALOGUE]).

2. SHOT PROGRESSION, NOT SCENE JUMPS. Think like a cinematographer covering one continuous action: wide → medium → close-up → reaction shot → back to medium → insert → ... Action, location and time flow CONTINUOUSLY from shot to shot: shot N+1 starts exactly where shot N ended (same room, same light, same positions, same props). A change of location/time is allowed ONLY when explicitly motivated and written into locationDesc as a transition ("CUT TO: 2 hours later —", "SMASH CUT TO: EXT —"). At most 1–2 such transitions per episode.

3. ONE CONSISTENT VISUAL IDENTITY. Define it in "visualIdentity" and repeat that SAME sentence (verbatim or near-verbatim) in the [VISUAL STYLE] line of EVERY videoPrompt. Same visual treatment, lighting scheme and color palette in all ${SCENES_PER_EPISODE} shots — the cut must never feel like a different camera.

4. IDENTICAL CHARACTER DESCRIPTIONS. Build "characterSheet" first (age range, hair, skin, build, distinctive features, EXACT clothing for this episode). Then, in every videoPrompt where a character is visible, paste their characterSheet description WORD FOR WORD into [CHARACTER]. Never vary hair, clothes or features between shots. Use the character names given below.

5. EMOTIONAL CAMERA LANGUAGE — the camera must express the emotion of the beat:
   • Tension / fear: handheld, tight close-ups, rack focus, shallow depth of field, unsteady framing
   • Calm / intimacy: steady tripod or slow dolly, wide or medium shots, soft motion
   • Revelation / realization: slow zoom in, dramatic push-in on the face, held stare
   • Action / urgency: tracking shot, whip pan, dynamic following movement
   • Isolation / dread: wide shot with the character small in frame, negative space, static camera
   State the camera movement explicitly in [SHOT TYPE] / [ACTION].

6. TRANSITIONS — EVERY SHOT HANDS OFF TO THE NEXT. The [TRANSITION] line describes how this shot connects to the following one: what the camera lands on, what the character turns toward, what sound/motion carries over. Examples: "camera slowly pans right and settles on the closed door — the next shot opens on that door", "holds on her face as her eyes drop to the phone in her hand — next shot is the phone screen", "match cut: the glass she sets down becomes the glass on the lab table". The last shot's transition sets up the cliffhanger / next episode.

7. DIALOGUE — CHARACTERS TALK TO EACH OTHER. The audience bonds with the characters through what they say, so this is a DIALOGUE-DRIVEN series: only ${MIN_SILENT_SCENES}–${MAX_SILENT_SCENES} scenes are purely visual (establishing, reaction, atmosphere, insert) — write exactly "[NO DIALOGUE]" for those; EVERY other scene carries spoken dialogue.
   • REQUIRED: A REAL BACK-AND-FORTH EXCHANGE, NOT A SINGLE LINE. Each talking scene MUST contain a short exchange between TWO characters — at least 2, ideally 3, lines that ANSWER each other (a line, a reply, and often a comeback), written as SEPARATE "SPEAKER: line" lines. A talking scene with only ONE isolated line is WRONG — the whole point is that the characters converse. Alternate the speakers (A, then B, then A).
   • HONEST DURATION — each talking scene is rendered as an ~${DIALOGUE_CLIP_SECONDS}-second clip (not ${SCENE_SECONDS}s), which comfortably carries a 2–3 line exchange of roughly 18–40 spoken words IN TOTAL. Keep it inside that budget — natural, punchy lines, no monologues, nothing that could not physically be spoken in ~${DIALOGUE_CLIP_SECONDS} seconds.
   • A LONGER CONVERSATION SPANS SEVERAL SCENES, each still a full 2–3 line exchange. When a conversation runs long, keep it going across consecutive shots — but each of those shots still carries its OWN 2–3 line back-and-forth beat (never drop to a single line just because the talk continues next shot).
   • TONE OF VOICE ON EVERY LINE. Give each spoken line a brief delivery cue in parentheses right after the speaker name: HOW it is said — the tone, emotion and manner (e.g. "(low, guarded)", "(a shaky whisper, holding back tears)", "(mockingly, half-laughing)", "(a tired sigh, then flat)"). These cues are performance directions only; they are NEVER spoken aloud and NEVER shown as subtitles.
   Follow a film rhythm, e.g.: establishing (silent) → exchange → reaction (silent) → exchange continues → insert → exchange → ...
   EXAMPLE of ONE talking scene's "dialogue" field (note: MULTIPLE lines that answer each other, each with a tone cue):
     ANSEL (guarded, not turning around): "You shouldn't be here."
     WREN (quiet, stepping closer): "Neither should you, after what happened."
     ANSEL (a bitter breath): "Say his name, then. Say it."

8. STORY. Dramatize ONLY the events of THIS episode's description — do NOT borrow, foreshadow in detail, or resolve events from the other episodes listed (they are told in their own episodes). Open by picking up naturally from the previous episode's cliffhanger (given below) and build steadily toward THIS episode's cliffhanger, landing on it in the final shot. Dialogue is natural, subtext-rich, screenplay format.

============ videoPrompt FORMAT (English, always, exactly these 9 lines, in this order) ============
[SHOT TYPE]: <Wide establishing shot / Medium shot / Close-up / Over-the-shoulder / POV / Tracking shot / Reaction shot / Insert> + camera movement (static / slow dolly in / handheld / slow zoom / pan right ...), vertical 9:16 framing
[VISUAL STYLE]: <the visualIdentity sentence — identical in every scene>
[LIGHTING]: <HOW the light falls in THIS shot — light source(s) and direction (e.g. hard window light from camera-left, a single overhead bulb, warm street lamp, cold monitor glow), quality (hard/soft, diffused), where the shadows fall, highlights and rim light, and the colour temperature/palette; keep it consistent with [VISUAL STYLE]>
[BLOCKING]: <WHERE each character is placed and how they move — who stands / sits / leans and where in the frame (foreground/background, camera-left/right), the distance and spatial relationship between them, and any movement or gesture during the beat (steps closer, turns away, folds arms, sets something down)>
[GAZE]: <the EYELINES — who looks at whom or at what (e.g. "she stares straight into his eyes", "he looks down at the phone", "his eyes flick to the door", "she avoids his gaze, looking at the floor"); state each visible character's gaze direction>
[NON-VERBAL]: <the wordless performance — facial micro-expressions, sighs, breathing, swallowing, trembling, a tightening jaw, a flicker of a smile, tears welling, body language and posture that reveal the inner emotion of the beat>
[ACTION]: <exactly what happens in these ~${SCENE_SECONDS} seconds, one clear beat, present tense, concrete and filmable; include the emotion on faces>
[CHARACTER]: <verbatim characterSheet description of every visible character; write "none visible" for empty frames>
[TRANSITION]: <how this shot connects to the next shot>

Never mention real people, brands, logos or existing films/characters. No on-screen text, no subtitles, no music references.

============ ORIGINAL VISUAL DESIGN RULES ============
Describe original designs directly. These rules do not guarantee provider moderation approval:
- NEVER name real actors, celebrities, musicians, politicians, athletes, influencers or ANY real person — not as a lookalike either ("looks like Angelina Jolie", "a young Brad Pitt" are FORBIDDEN). Describe people generically and concretely instead: "a woman in her 30s with dark shoulder-length hair and sharp cheekbones".
- NEVER name directors, cinematographers, photographers or their signature styles ("Wes Anderson symmetry", "Fincher-esque", "Deakins lighting", "in the style of Kubrick"). Describe the technique itself: "perfectly centered symmetrical framing", "low-key cool-toned lighting with deep shadows", "slow push-in with shallow depth of field".
- NEVER reference specific films, TV series, games, anime, comics or their characters, worlds, props or scenes ("Blade Runner neon", "like the Matrix lobby scene", "a Joker-style grin", "Hogwarts-like castle"). Describe the imagery directly: "rain-soaked street lit by pink and cyan neon signs".
- NEVER name brands, products, logos, trademarks or branded gear — including phones, cars, sneakers, fashion labels, drinks, apps, camera bodies and film stocks ("iPhone", "BMW", "Nike", "Gucci", "Coca-Cola", "Netflix", "Arri Alexa", "Kodak Portra"). Use generic nouns: "smartphone", "black sedan", "plain white sneakers", "35mm film stock". No visible logos or text anywhere in frame.
- NEVER reference art styles by artist or studio name ("Van Gogh brushstrokes", "Rembrandt lighting", "Ghibli style", "Pixar look"). Describe the visual qualities: "thick expressive brushstrokes", "classic three-quarter portrait lighting", "soft hand-drawn animation look".
- Character names are the fictional names from the character list below — never a real person's full name.
If in doubt, DESCRIBE what the camera sees in plain, generic cinematic language. Prompts that break this rule are unusable.

============ LANGUAGE RULES ============
- "dialogue" and "locationDesc" are written in the SAME LANGUAGE as the synopsis / episode description (Russian synopsis → Russian dialogue and locations).
- "visualIdentity", "characterSheet" and "videoPrompt" are ALWAYS in English — they drive the AI video model.
- Exactly ${SCENES_PER_EPISODE} scenes, numbered 1..${SCENES_PER_EPISODE}, in shooting/screening order.`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:scenes", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, scenesSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, episodeId } = parsed.data;

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { project: true } } },
    });
    if (!episode)
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });

    const pid = projectId || episode.season?.projectId;
    const synopsis = episode.season?.project?.synopsis ?? "";

    // Fetch the whole season's episode list (for scope boundaries) and the
    // previous episode (for a smooth continuation into this one).
    const seasonEpisodes = episode.seasonId
      ? await prisma.episode.findMany({
          where: { seasonId: episode.seasonId },
          orderBy: { number: "asc" },
          select: { number: true, title: true, description: true, cliffhanger: true },
        })
      : [];

    const episodeListText = seasonEpisodes
      .map(
        (e) =>
          `  Episode ${e.number}: "${e.title}" — ${e.description ?? "(no description)"}${
            e.number === episode.number ? "   <<< THIS EPISODE — dramatize ONLY this" : ""
          }`
      )
      .join("\n");

    const prevEpisode = seasonEpisodes
      .filter((e) => e.number < episode.number)
      .sort((a, b) => b.number - a.number)[0];
    const prevContext = prevEpisode
      ? `Previous Episode ${prevEpisode.number} ("${prevEpisode.title}") ended on this cliffhanger — continue naturally from it:\n"${prevEpisode.cliffhanger ?? prevEpisode.description ?? "N/A"}"`
      : "This is the FIRST episode — open the story from the beginning.";

    const characters = await prisma.character.findMany({
      where: { projectId: pid },
      select: { name: true, role: true, description: true, appearance: true },
    });

    const charSummary = characters
      .map((c) => `- ${c.name} (${c.role}): ${c.description}. Appearance: ${c.appearance}`)
      .join("\n");

    const userMsg = `Project synopsis: ${synopsis}

Characters:
${charSummary || "No characters defined yet."}

Full episode list for this season (for scope only — each episode is told in its OWN episode, do NOT borrow their events):
${episodeListText || "  (single episode)"}

${prevContext}

>>> GENERATE SCENES ONLY FOR THIS EPISODE <<<
Episode ${episode.number}: "${episode.title}"
Description: ${episode.description}
This episode's ending cliffhanger (build toward it): ${episode.cliffhanger ?? "N/A"}

Direct this episode as ONE continuous piece of film: first write "visualIdentity" and the "characterSheet", then exactly ${SCENES_PER_EPISODE} consecutive camera shots (scene 1 = wide establishing shot; only ${MIN_SILENT_SCENES}–${MAX_SILENT_SCENES} shots marked [NO DIALOGUE], EVERY other shot carrying a REAL back-and-forth exchange of 2–3 lines where the characters ANSWER each other (never a single isolated line), each spoken line on its own "SPEAKER (tone): line" row; a longer conversation spans several consecutive shots, each still a full 2–3 line exchange; every videoPrompt in the full 9-line format — [SHOT TYPE], [VISUAL STYLE] (identical every scene), [LIGHTING], [BLOCKING], [GAZE], [NON-VERBAL], [ACTION], [CHARACTER] (verbatim descriptions), [TRANSITION] handing off to the next shot) that dramatize ONLY this episode's description — from a natural continuation of the previous episode to this episode's cliffhanger.`;

    const data = await chatJSON<{
      visualIdentity?: string;
      characterSheet?: Record<string, string>;
      scenes: any[];
    }>(SYSTEM, userMsg, {
      temperature: 0.8,
      // ${SCENES_PER_EPISODE} scenes (≈12) each with a detailed 9-line videoPrompt
      // (lighting, blocking, gaze, non-verbal ...) plus multi-line dialogue and the
      // identity/character blocks need generous room, or the JSON gets truncated.
      maxTokens: 16000,
    });

    const rawScenes = Array.isArray(data?.scenes) ? data.scenes : [];
    if (rawScenes.length === 0) throw new Error("Model returned no scenes");

    const visualIdentity = (data.visualIdentity ?? "").trim();
    const characterSheet = data.characterSheet ?? {};

    // Normalize: sequential numbering, trimmed to the target count, guaranteed
    // visual-style line in every prompt so all clips share one look.
    const scenesOut = rawScenes.slice(0, SCENES_PER_EPISODE).map((s, i) => {
      let videoPrompt = String(s?.videoPrompt ?? "").trim();
      if (visualIdentity && !/\[VISUAL STYLE\]/i.test(videoPrompt)) {
        videoPrompt = `[VISUAL STYLE]: ${visualIdentity}\n${videoPrompt}`;
      }
      const dialogue = String(s?.dialogue ?? "").trim() || "[NO DIALOGUE]";
      return {
        number: i + 1,
        dialogue,
        locationDesc: String(s?.locationDesc ?? "").trim(),
        videoPrompt,
      };
    });

    // Diagnostics for cohesion rules (never fatal — the model output is still usable).
    const silentCount = scenesOut.filter((s) => /\[NO DIALOGUE\]|\[VISUAL MONTAGE\]/i.test(s.dialogue)).length;
    const establishing = /establishing|wide|aerial|drone/i.test(scenesOut[0]?.videoPrompt ?? "");
    console.log(
      `[scenes] ${episodeId}: ${scenesOut.length}/${SCENES_PER_EPISODE} shots, silent=${silentCount} (target ${MIN_SILENT_SCENES}–${MAX_SILENT_SCENES}), ` +
        `establishing=${establishing}, identity="${visualIdentity.slice(0, 60)}", characters=${Object.keys(characterSheet).join("/")}`
    );

    // Clear existing scenes
    await prisma.scene.deleteMany({ where: { episodeId } });

    const created = [];
    for (const s of scenesOut) {
      const scene = await prisma.scene.create({
        data: {
          episodeId,
          number: s.number,
          dialogue: s.dialogue,
          locationDesc: s.locationDesc,
          videoPrompt: s.videoPrompt,
          status: "pending",
        },
      });
      created.push(scene);
    }

    return NextResponse.json({ scenes: created, visualIdentity, characterSheet });
  } catch (err: any) {
    console.error("Scene generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
