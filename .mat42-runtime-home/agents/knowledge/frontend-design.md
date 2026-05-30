# Frontend Design Philosophy

Always apply when generating any app for Matrix OS. Mirrors the official `frontend-design` skill that ships with Claude Code, contextualized for the Matrix OS builder agent.

The condensed version of these principles is inlined directly in `BUILDER_PROMPT` (packages/kernel/src/agents.ts) so they're always active without requiring a knowledge-file read. This file is the canonical source for humans browsing the project and for future agents (healer, evolver) that may consult it.

## The Core Commitment

Before writing any code, commit to a BOLD aesthetic direction. Pick an extreme:

- Brutally minimal (Linear, iA Writer)
- Refined-luxury (Apple, Stripe)
- Retro-futuristic (early-internet wonder, evolved)
- Editorial / magazine (NYT, Substack)
- Playful / toy-like (Amie, Tldraw)
- Brutalist / raw (anti-design, deliberately rough)
- Organic / natural (warm tones, soft shapes)
- Soft / pastel (dreamy, gentle)
- Art-deco / geometric (precise, layered)
- Industrial / utilitarian (Figma, dev tools)

Don't half-commit. The bold commitment is what separates memorable apps from generic AI output. The "safe middle" is the trap.

## Match Implementation Complexity to Aesthetic Vision

- **Maximalist directions**: need elaborate code -- animations, layered effects, distinctive details. Restraint here looks unfinished.
- **Refined / minimal directions**: need precision and restraint -- careful spacing, hairline borders, minimal motion. Decoration here looks cluttered.

Elegance comes from executing the vision well, not from picking a "safer" middle.

## NEVER

- **Generic font families.** Inter alone, Roboto, Arial, "system-ui" alone are AI-slop tells. Pair a distinctive display font with a refined body font.
- **Cliched color schemes.** Purple-on-white gradients, "modern SaaS pastels," tech-blue everywhere, evenly-distributed timid palettes. Dominant colors with sharp accents outperform balanced palettes.
- **Cookie-cutter components.** Centered card with title + paragraph + button is the AI default. Compose with intent for the app's specific purpose.
- **Predictable layouts.** Header + sidebar + main grid every single time is generic. Use asymmetry, overlap, generous space, controlled density.
- **Convergence across generations.** If you generated a "habit tracker" yesterday and another today, they should differ in details. Vary fonts, themes, vibes aggressively.
- **Solid-color backgrounds as the default.** They are the floor, not the ceiling.

## ALWAYS

- **Pick ONE distinctive detail someone would remember.** A signature animation, a bold typographic moment, an unusual layout choice. The thing they'd describe to a friend.
- **Use atmosphere and depth.** Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, grain overlays.
- **Treat the page-load as ONE orchestrated moment.** Staggered reveals on initial render beat scattered micro-interactions everywhere.
- **Use CSS variables for color/spacing/radius consistency.** Apps that mix tokens with hardcoded values feel sloppy.
- **Vary aggressively across themes.** Light/dark, serif/sans/mono, rigid/playful. Apps should feel like they came from different studios.

## Don't Hold Back

You are capable of extraordinary creative work. The default tendency is to play it safe -- to hedge toward the median. Resist that. Every app is a portfolio piece for Matrix OS.
