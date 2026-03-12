# AI Generation Prompting Guide

Quick-reference for all tools used in the "Yours, Truly" trailer production.

---

## Table of Contents

1. [Nano Banana 2 (Image)](#nano-banana-2)
2. [Nano Banana Pro (Image)](#nano-banana-pro)
3. [Veo 3.1 (Video)](#veo-31)
4. [Seedance 2.0 (Video)](#seedance-20)
5. [Kling 3.0 (Video)](#kling-30)
6. [Cross-Tool Workflow](#cross-tool-workflow)

---

## Nano Banana 2

**What it is**: Gemini 3.1 Flash Image. Fast generation with Pro-level intelligence. Best for rapid iteration and initial keyframe exploration.

### Prompt Structure

```
[Style] + [Subject] + [Setting] + [Action] + [Composition]
```

### Golden Rules

| Do | Don't |
|----|-------|
| Write like a Creative Director: full sentences, descriptive | Use "tag soup" (dog, park, 4k, realistic) |
| Start simple, add detail incrementally | Overload the first prompt with everything |
| Edit conversationally ("make the lighting warmer") | Re-roll from scratch when 80% is right |
| Specify camera, lens, time of day, city's visual language | Leave composition to chance |
| Wrap text in quotation marks: `"Happy Birthday"` | Say "add some text" without specifying content |

### Text Rendering

- Wrap exact words in quotation marks
- Specify font style: "bold sans-serif", "neon cursive signage"
- Define placement: "centered at top", "bottom-right corner"
- Keep text short: 3-5 words maximum for reliable rendering

### Character Consistency

- Upload clear reference photos
- Assign distinct names to characters
- Maintains identity across up to 5 characters in a workflow
- Reuse the same descriptor consistently

### Aspect Ratios

- Use in-product dropdowns for 4:3, 1:1, 9:16, 16:9
- Supports 2K and 4K upscaling
- For our trailer: always 16:9

### Example (adapted for our trailer)

```
A cinematic close-up of a phone screen lighting up on a bedside table
in a dark room. 47 notification badges visible across app icons. The
cold blue screen light casts harsh shadows on white rumpled bed sheets.
Shot on 35mm film, f/1.4, Fincher-style color grading, desaturated,
clinical. 16:9 aspect ratio.
```

---

## Nano Banana Pro

**What it is**: Gemini 3 Pro Image. "Thinking" model -- reasons through composition before generating. Best for complex scenes, text-heavy shots, and maintaining consistency across sequences.

### Key Differences from Nano Banana 2

| Nano Banana 2 (Flash) | Nano Banana Pro |
|------------------------|-----------------|
| Fast, pattern-matching | Structure and reasoning ("thinking" model) |
| Quick iteration | Complex scenes, infographics, text |
| Up to 5 character refs | Up to 14 reference images (6 high-fidelity) |
| Good text rendering | Perfect text rendering (long sentences, logos) |
| No search grounding | Google Search grounding for real-time data |

### The "Thinking" Process

The model generates interim thought images (not charged) before final output. This means:
- It reasons about physics, composition, and spatial relationships
- Complex prompts that would confuse Flash work well on Pro
- You get better results on first try for intricate scenes

### Reference Image System (up to 14 images)

- **Identity Locking**: "Keep the person's facial features exactly the same as Image 1"
- **Expression Variation**: Describe emotional/pose changes while maintaining identity
- **Group Consistency**: Multiple characters across sequences
- **Layout Control**: Upload sketches, wireframes, or grids to structure composition

### Advanced Techniques

**Edit, don't re-roll**: If 80% right, say "change the lighting to golden hour and make the background warmer" -- the model understands conversational edits perfectly.

**Provide context**: Explain the purpose. "This is a key frame for a cinematic film trailer about technology" helps the model infer professional lighting and composition.

**Dimensional translation**: Can convert 2D sketches to photorealistic renders -- useful for storyboard-to-keyframe workflow.

### When to Use Pro vs Flash

- **Use Pro for**: Act 3 character scenes (consistency across cultures), text cards (Act 4), the federation map (3.15), any shot with multiple characters
- **Use Flash for**: Act 1 screen close-ups, quick iterations, texture/particle shots (Act 2)

---

## Veo 3.1

**What it is**: Google's most powerful video generation model. Generates up to 8 seconds of video with synchronized audio, dialogue, and sound effects.

### Prompt Structure (5-Part Formula)

```
[Shot Composition] + [Subject Details] + [Action] + [Setting/Environment] + [Aesthetics/Mood]
```

Optimal length: 3-6 sentences / 100-150 words.

### Key Capabilities

- **Resolution**: 720p or 1080p at 24 FPS
- **Duration**: 4, 6, or 8 seconds per clip
- **Aspect ratio**: 16:9 or 9:16
- **Audio**: Dialogue, SFX, ambient noise, music -- all synchronized
- **Negative prompting**: Supported

### Audio Direction Syntax

Separate audio from visual description with clear labels:

```
Visual: A young man sits at a desk in warm morning light, speaking
to a computer screen. A waveform responds to his voice on the monitor.

Audio: Soft ambient room tone. The man speaks naturally: "I need to
track my expenses this month." Faint keyboard sounds in background.

SFX: Subtle digital chime when the waveform activates.
```

### Camera Movement Options

dolly shot, tracking shot, crane shot, aerial view, slow pan, POV shot, handheld, steadicam, zoom in/out, orbit, push-in, pull-out

### Critical Rules

| Do | Don't |
|----|-------|
| Focus each clip on ONE dominant action | Combine walking + speaking + gesturing in one clip |
| Use evocative sensory language (light, texture, atmosphere) | Write dry, technical descriptions |
| Declare visual style upfront (realistic, animated, film noir) | Leave style ambiguous |
| Specify exact dialogue in quotes | Describe dialogue vaguely ("they talk about something") |
| Add negative prompts to remove unwanted elements | Hope the model avoids problems on its own |

### Veo 3.1 Prompt Template (for our trailer)

```
Shot composition: Medium close-up, over-the-shoulder, shallow depth
of field (f/2.0).

Subject: A young man in his late 20s, sitting at a minimal wooden desk.
Casual clothing. Relaxed posture.

Action: He speaks calmly toward the computer screen. A subtle waveform
animation responds on the monitor.

Setting: A warm, naturally lit Scandinavian apartment. Morning golden
hour light streaming through a window. Plants on the windowsill.
Clean, minimal decor.

Aesthetics: Spike Jonze "Her" color grading. Warm amber tones. Soft,
intimate. 35mm film texture. No harsh shadows.

Audio: Room ambience -- distant city sounds, soft fabric movement.
Man's voice (natural, conversational): "Show me my week."
Subtle UI chime when the calendar appears on screen.

Negative: No blue screen glow, no harsh lighting, no corporate/sterile
environment, no visible branding.
```

---

## Seedance 2.0

**What it is**: ByteDance's cinematic-grade video generator. Excels at camera control and image-to-video animation. 4 input modalities.

### Prompt Structure

```
[Subject] + [Action/Motion] + [Style/Mood] + [Camera] (optional)
```

### Golden Rules

| Do | Don't |
|----|-------|
| Keep under 60 words -- precision over volume | Write long poetic paragraphs |
| Use concrete descriptors: "golden hour", "shallow depth of field" | Use vague words: "cool", "nice", "interesting" |
| Add "cinematic" or "4K" at the end (reliably improves quality) | Forget style keywords |
| Use "slow motion" for smoother, controlled motion | Overload with subjects and actions |
| Focus on motion/camera for image-to-video (don't re-describe image) | Re-describe the source image in i2v prompts |

### The @ Reference System (Groundbreaking Feature)

Tag elements in your prompt with @ followed by a label, then bind to uploaded references:

```
@Character1 wearing the specific charcoal tuxedo from @ReferenceImage2
with the silver lapel pin visible on left lapel.
```

This reduces the AI's "guessing" by tethering specific visual elements to reference images.

### Multi-Shot Generation

- Sweet spot: 2-3 shots per generation
- Use "lens switch" to signal a new shot
- Describe each scene sequentially
- More than 5 shots = quality degrades ("Subject Anchor" frays)

### Image-to-Video Tips

This is key for our workflow (keyframe -> animated clip):

```
# DON'T (re-describes the image):
"A phone on a bedside table with notifications, blue light, dark room"

# DO (describes motion and camera):
"Camera slowly pulls back. Phone screen flickers with incoming
notifications. Soft blue light pulses on the sheets. Slight handheld
camera shake."
```

Keep i2v prompts short and motion-focused. The image already provides the visual -- you're just adding time.

### Camera Control

Describe naturally: orbit, aerial, zoom in/out, pan, tracking shot, handheld shake, dolly, crane, static

### Seedance 2.0 Template (for our trailer)

```
Close-up of hands slowly closing a laptop. The blue screen light
fades, room goes dark. Slow, deliberate motion. Cinematic, shallow
depth of field, 4K.
```

---

## Kling 3.0

**What it is**: Kuaishou's flagship video model. 15-second generation, multi-shot sequences, native audio/dialogue, 4K output.

### Prompt Structure (Master Formula)

```
[Context/Scene] + [Subject & Appearance] + [Action Timeline] +
[Camera Movement] + [Audio & Atmosphere] + [Technical Specs]
```

### The Director Mindset

The key shift: write **directorial** prompts, not **descriptive** ones.

```
# Descriptive (weak):
"A busy crosswalk with a woman walking"

# Directorial (strong):
"Camera tracks backward in front of her as she walks confidently
down a busy New York crosswalk, shallow depth of field isolating
her from the blurred crowd."
```

### Action Timeline (The "Secret Sauce")

Sequence actions explicitly:

```
"First, the person stares at the laptop screen in frustration.
Then, they slowly reach forward and close the laptop.
Finally, the room goes dark as the screen light disappears."
```

### Multi-Shot Sequences (up to 15 seconds)

```
Shot 1 (0-5s): Wide establishing shot of a sunlit room in Cairo.
An elderly woman sits at a table with a tablet.

Shot 2 (5-10s): Medium close-up of her face. She's laughing during
a video call, speaking Arabic.

Shot 3 (10-15s): Close-up of the tablet screen showing the call,
with medication reminders paused in a sidebar.
```

### Camera Language

| Movement | Best for |
|----------|----------|
| Dolly zoom | Psychological impact, vertigo |
| Truck left/right | Lateral reveals |
| Low-angle tracking | Heroic/imposing subjects |
| FPV (first person) | High-energy immersion |
| Over-the-shoulder | Intimate character moments |
| Macro close-up | Detail emphasis (screens, hands) |
| Wide establishing | Scene setting, context |

### Native Audio & Dialogue

```
[Speaker: Elderly Woman] "(warmly, in Arabic) It just... knows
what I need."

Atmosphere: Warm room ambience, distant Cairo street sounds,
birdsong from an open window. Soft instrumental music from
a radio in another room.
```

- Tag speakers explicitly to prevent "audio ghosting"
- Specify emotional tone in parentheses
- Supports: Chinese, English, Japanese, Korean, Spanish (+ dialects)

### Negative Prompting

Kling defaults to overly optimistic/cheerful. For serious scenes:

```
Negative: Smiling, laughing, cartoonish, bright oversaturated colors,
low resolution, morphing, blurry text, disfigured hands, extra fingers
```

### Aspect Ratios

- **16:9**: Our trailer standard
- **21:9**: Cinematic widescreen (consider for establishing shots)
- **9:16**: Social media vertical (for promotional clips)

### Quality Tip

Generate at 1080p until prompt is dialed in, then switch to 4K for final render. Saves credits significantly.

### Kling 3.0 Template (for our trailer)

```
Context: A warm, sunlit apartment in Cairo. Plants on the windowsill,
family photos on the wall. Late afternoon light.

Subject: An elderly Egyptian woman (70s), warm expression, wearing a
comfortable traditional house dress. Silver hair partially covered
with a light headscarf.

Action Timeline: First, she laughs warmly while looking at a tablet
on the table (video call in progress). Then, the call ends and her
expression softens to fondness. Finally, she touches the tablet
screen gently, as if thanking it.

Camera: Starts medium shot, slowly pushes in to close-up on her
face during the emotional beat.

Audio: [Speaker: Grandmother] "(in Arabic, warmly) It just knows
what I need." Ambient: distant Cairo traffic, birdsong, the soft
click of the video call ending.

Technical: Cinematic, shallow depth of field, warm golden color
grading, Her (2013) aesthetic, 16:9.

Negative: Cold blue lighting, sterile/clinical environment, sad
expression, modern/minimalist decor, Western setting.
```

---

## Cross-Tool Workflow

### Our Production Pipeline

```
1. IDEATE        Nano Banana 2 (Flash)     Quick concept exploration
                                            Rapid iteration on framing
                                            Test compositions

2. REFINE        Nano Banana Pro            Final keyframes
                                            Character consistency (refs)
                                            Text cards (Act 4)
                                            Complex multi-element scenes

3. ANIMATE       Choose per shot:
                 - Veo 3.1                  Best for: dialogue scenes,
                                            audio-synced shots, warm
                                            ambient scenes (Act 3)

                 - Seedance 2.0             Best for: image-to-video
                                            animation, camera control,
                                            short precise clips (Act 1)

                 - Kling 3.0               Best for: multi-shot sequences,
                                            15-sec continuous takes,
                                            character close-ups, dialogue
                                            in multiple languages

4. COMPOSITE     Video editor               Stitch clips, color grade,
                                            add music, sound design,
                                            typography (After Effects)
```

### Tool Selection Per Act

| Act | Image Gen | Video Gen | Why |
|-----|-----------|-----------|-----|
| Act 1: The Noise | Nano Banana 2 (fast iteration, screen close-ups) | Seedance 2.0 (short precise clips, strong camera control for fast cuts) | Fast cuts = many short clips. Seedance's i2v is perfect for animating each keyframe with 2-3 seconds of motion. |
| Act 2: The What-Ifs | Nano Banana 2 (particles, abstract dark shots) + Pro (search bar UI shots) | Veo 3.1 (ambient, slow, audio-synced whispers) | The whispered voices need audio sync. Veo's native audio generation handles this natively. |
| Act 3: The Flow | Nano Banana Pro (character consistency across 5 countries, reference system) | Kling 3.0 (multi-shot, dialogue in Arabic/Spanish/Hindi/Mandarin, 15-sec takes) | Multiple languages + dialogue + character consistency = Kling's wheelhouse. Use Elements 3.0 for face locking. |
| Act 4: The Close | Nano Banana Pro (text cards) + Figma/AE (typography) | Seedance 2.0 (intercut flashes, 2-3 sec clips) + After Effects (text animation) | Intercuts are 1-second flashes -- Seedance handles these well. Text cards are better built in motion graphics software. |

### Consistency Checklist

Before generating production-quality images:

1. Generate the wide establishing shot FIRST as a style reference
2. Use that image as a reference for all subsequent shots in the same location
3. Lock character faces with Nano Banana Pro's reference system (up to 14 images)
4. Maintain color grading consistency:
   - Act 1: Cool blue (#1a2a4a to #3a5a8a), desaturated, Fincher
   - Act 2: Dark -> warm amber transition
   - Act 3: Warm golden (#d4a574 to #e8c49a), Her color grading
   - Act 4: Alternating between Act 1 and Act 3 palettes
5. For video: generate at 1080p first, upscale finals to 4K

### Prompt Adaptation Rules

When converting our storyboard prompts (written for Midjourney) to each tool:

**For Nano Banana 2/Pro**: Remove `--ar 16:9 --style raw --v 6.1` suffixes. Use natural language. Add context about the project. Specify 16:9 in the tool's UI settings.

**For Veo 3.1**: Restructure into the 5-part formula. Add audio direction. Separate Visual/Audio/SFX sections. Keep to 100-150 words.

**For Seedance 2.0**: Compress to under 60 words. Focus on subject + action + style + camera. For i2v: describe ONLY the motion, not the scene. Add "cinematic, 4K" at the end.

**For Kling 3.0**: Expand into the master formula (context + subject + action timeline + camera + audio + specs). Use sequential action structure ("First... then... finally..."). Add negative prompts. Tag dialogue speakers.

---

## Sources

- [Google DeepMind: Nano Banana Prompt Guide](https://deepmind.google/models/gemini-image/prompt-guide/)
- [Google Cloud: Ultimate Prompting Guide for Nano Banana](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)
- [DEV Community: Nano Banana Pro Prompting Guide & Strategies](https://dev.to/googleai/nano-banana-pro-prompting-guide-strategies-1h9n)
- [Google DeepMind: Veo Prompt Guide](https://deepmind.google/models/veo/prompt-guide/)
- [Google Cloud: Ultimate Prompting Guide for Veo 3.1](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)
- [Seedance Blog: Seedance 2.0 Prompt Guide](https://www.seedance.best/blog/seedance-prompt-guide/)
- [Kling AI: Kling 3.0 Prompt Guide](https://klingaio.com/blogs/kling-3-prompt-guide)
- [Atlabs: Kling 3.0 Prompting Guide](https://www.atlabs.ai/blog/kling-3-0-prompting-guide-master-ai-video-generation)
- [eWeek: Best Nano Banana 2 Prompts 2026](https://www.eweek.com/news/best-nano-banana-2-prompts-gemini-3-1-flash-image/)
- [Atlabs: Nano Banana 2 Prompting Guide](https://www.atlabs.ai/blog/nano-banana-2-prompting-guide)
