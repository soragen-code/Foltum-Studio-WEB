/**
 * Stage 93 — DIRECTING RULES.
 *
 * A single shared directing instruction embedded verbatim into every automatic
 * scene-prompt SYSTEM prompt (scenes-job.ts, season.ts episodeScriptSystemPrompt,
 * season.ts sceneReviseSystemPrompt) so the model stages each scene like a real
 * live-action drama series — clear action, natural behavior and spatial continuity —
 * rather than a set of striking but disconnected images.
 *
 * This is an ADDITIVE block: it does not replace the existing detailed scene rules,
 * it sits alongside them as a clearly-labelled directing layer.
 */
export const DIRECTING_RULES = `DIRECTING RULES — shoot like a live-action drama series.
Describe the scene as a real staged performance with actors, a physical set and a real shooting camera — NOT as a set of striking images. Priority: clear action, natural behavior, and spatial continuity.
1. Space first, then action, then camera. Fix the location's main landmarks and each character's position. Decide what each one does and where they move. Only then choose the angles from which the action reads clearly to the viewer.
2. Preserve the scene's geography. Between shots, object positions, distances, exits, light sources and movement directions do NOT change. A new camera changes perspective and occlusion, not the layout of the location.
3. Respect the screen axis (180-degree rule). Keep consistent directions of gaze, movement and interaction. Do not jump to the opposite side of the axis without a wide shot or a visible camera move that explains the reorientation.
4. Make every action physically possible. A character must be at a suitable distance, have a free hand and enough time to move. Show the necessary approaches, turns, object hand-offs and shifts of support. No teleporting, no acting through obstacles.
5. Link cause and effect. The viewer must understand who acted on what and what happened as a result. Show key interactions — a touch, a hand-off, a hit, a shot, a fall — with a readable spatial connection, and where possible without cutting away at the decisive moment.
6. Choose the frame for the dramatic task. A wide shot explains the space, a medium shot shows interaction and gestures, a close-up stresses an important reaction or detail. Do not demand showing all participants and a small hand action at the same time. Characters outside the frame keep existing in their places.
7. Motivate the cut. Change the shot for a new action, reaction, piece of information or emotional accent — not to hit a mandatory number of cuts. Do not repeat one movement from its start after a camera change. Keep the movement phase continuous across the cut.
8. Give actions real time. Do not put more movement, lines and reactions into a short shot than can be performed naturally. If a scene is overloaded, cut actions or split it into additional shots — do not speed up the actors.
9. Stage living behavior, not demo poses. Every character has a goal, an object of attention and a reaction to what is happening. Gestures, pauses and moves must have a reason. Do not make everyone gesture constantly or turn to the camera.
10. Keep material continuity. Positions of objects, which hands are occupied, weapon state, damage, marks, clothing and open doors carry into the next shot. Only what actually changed in the shown action changes.
11. Keep light and sound unified. Light sources stay fixed in space. Ambient sound continues across cuts; action sounds match their visible causes. Dialogue is never cut off or sped up for the sake of the edit.
12. Write unambiguously, without filler templates. For each shot specify: camera position, scale, the main action, the object of attention, and the moment of transition. Remove repetitions, off-topic examples and contradictory requirements.
Check before output: could this scene be staged with real actors in a single set, shot with the specified cameras, and edited without unexplained jumps? If not — simplify or fix the staging.
Guiding principle: the viewer always understands where the characters are, what they are looking at, what they are doing, and why the next result occurs.`;
