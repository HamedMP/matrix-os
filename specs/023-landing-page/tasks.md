# Tasks: Landing Page Story + Agent Showcase

**Task range**: T740-T752
**Parallel**: YES -- www/ only. Independent of kernel/gateway/shell. Can run alongside all other specs.
**Deps**: None.

## User Story

- **US-LP1**: "The landing page tells a compelling story that makes judges understand why Matrix OS exists"
- **US-LP2**: "Visitors can see agents working in real-time, not just static screenshots"

## Architecture

Current LP: Hero + TechStrip + HowItWorks + BentoFeatures + Web4 + CTA + Footer. Good structure but static.

Target: Story-driven LP that progresses from problem to vision to proof. Show Matrix OS building itself. Interactive elements that demonstrate the OS is real.

Key files:
- `www/src/app/page.tsx` (modify existing sections)
- `www/src/components/landing/` (new -- reusable LP sections)

## Part A: Story Narrative

- [ ] T740 [US-LP1] Rewrite LP copy as a narrative arc:
  - **Problem** (hero): "Your computer is stuck in 1984. Thousands of apps that don't talk to each other. An AI assistant in a chat box. Files scattered across services you don't control."
  - **Vision** (what-if): "What if your OS understood you? What if software wrote itself? What if every device you own was the same computer?"
  - **Proof** (how-it-works): "Tell it what you need. Watch it build. Use it instantly. Everything is a file you own."
  - **Depth** (features): bento grid showing real capabilities with actual data
  - **Future** (Web 4): the bigger vision, federated identity, AI-to-AI
  - **CTA**: "Get your instance" / "Read the whitepaper"

- [ ] T741 [US-LP1] Update hero section:
  - Stronger headline that communicates the paradigm shift
  - Sub-headline that's concrete (not abstract)
  - Interactive OS mockup that actually types/animates (not static)
  - Update test counts: "479 tests" instead of "200 tests"

- [ ] T742 [US-LP1] Update tech strip:
  - Current tech items are generic. Make them achievement-oriented:
  - "479 Tests Passing", "14 IPC Tools", "7 Skills", "6 Agents", "16 Spec Phases", "Telegram Connected"

## Part B: Agent Showcase

- [ ] T743 [US-LP2] Create agent showcase section:
  - Visual showing the agent team: Builder, Researcher, Deployer, Healer, Evolver
  - Each agent card: name, avatar/icon, description, example action
  - Animated flow: user request -> dispatcher -> agent selection -> tool usage -> result
  - Code-like visual showing actual agent prompt snippets

- [ ] T744 [US-LP2] Interactive demo element:
  - Option A: Embedded iframe showing actual shell (if instance running)
  - Option B: Recorded GIF/video of demo session
  - Option C: Scripted animation simulating a build session
  - Recommend Option C for reliability (no running instance needed)
  - Show: user types "Build me an expense tracker" -> agent thinks -> files created -> app appears in dock -> app opens

- [ ] T745 [US-LP2] Skills showcase:
  - Grid of available skills with icons
  - Click to expand: show skill description and example usage
  - "And you can create your own..." with skill-creator reference

## Part C: Customization Demo

- [ ] T746 [US-LP1] Theme variation showcase:
  - Show 3-4 theme variations of the same OS desktop
  - Toggle buttons: "Warm" (default), "Cool", "Dark", "Minimal"
  - Each shows different color palette applied to the mockup
  - Demonstrates "the OS adapts to you"

- [ ] T747 [US-LP1] Malleable landing page concept:
  - Add small "Customize this page" AI button in corner (experimental)
  - Clicking opens a prompt input: "What should this page look like?"
  - Server-side: AI generates CSS overrides, applies to page
  - This IS the demo: the landing page itself is built by Matrix OS
  - Note: this is ambitious. Can be a simple CSS variable swap instead of full AI generation.

## Part D: Polish

- [ ] T748 [US-LP1] Update CTA section:
  - Add whitepaper link
  - Add GitHub stars badge (dynamic, via shields.io)
  - Add hackathon reference
  - Email input for waitlist (or direct link to signup)

- [ ] T749 [US-LP1] Performance + SEO:
  - Ensure all images are optimized (WebP, lazy load)
  - Add proper meta tags (OG, Twitter Card)
  - Lighthouse score > 90
  - Page load < 2s

- [ ] T750 [US-LP1] Mobile LP polish:
  - Test all sections at 375px width
  - Animations disabled or simplified on mobile (prefers-reduced-motion)
  - Touch-friendly interactive elements
  - Fast scroll, no janky animations

## Implications

- **LP is the first impression**. More important than any single feature. Judges spend 30 seconds here.
- **Don't over-animate**. Subtle animations only. Performance > flashiness.
- **Content must be honest**. Don't claim features that don't work. Show what's real.
- **Malleable LP (T747) is experimental**. Start with CSS variable toggle, not full AI generation. Can evolve.
- **Interactive demo (T744)**: scripted animation is safest. Live demo risks: instance down, slow response, API errors.
- **Future**: LP becomes a living document that Matrix OS itself can update (eating your own dog food).

## Checkpoint

- [ ] LP tells a clear story from problem to vision to proof.
- [ ] Agent showcase section explains the team visually.
- [ ] Interactive demo shows a build session (animated or recorded).
- [ ] Mobile LP is polished and performant.
- [ ] Lighthouse score > 90.
