# Tasks: Whitepaper + Documentation

**Task range**: T730-T739
**Parallel**: YES -- content creation. Independent of all code work. Can be written by a separate agent.
**Deps**: None for content. T669 (ElevenLabs TTS) for audio version. PDF generation needs no deps (static HTML -> PDF via browser).

## User Story

- **US-WP1**: "Judges and users can read a comprehensive document explaining the vision, research, and architecture of Matrix OS"

## Architecture

Whitepaper is a long-form document covering philosophy, research background, architecture, and vision. Published as:
1. Web page at `matrix-os.com/whitepaper` (or `/docs`)
2. PDF download
3. Audio version (stretch, after ElevenLabs)

Key files:
- `www/src/app/whitepaper/page.tsx` (new route)
- `www/public/whitepaper.pdf` (generated)
- Content lives in the component itself (or markdown -> MDX)

## Implementation

### Content

- [ ] T730 [US-WP1] Whitepaper outline and content:
  - **Abstract**: Matrix OS is Web 4 -- a unified AI operating system. One paragraph.
  - **1. Introduction**: The problem with today's computing (fragmented apps, no AI integration, data silos). Why we need a new paradigm.
  - **2. Related Work**: Reference existing work:
    - Operating systems (Unix philosophy, Plan 9, everything-is-a-file)
    - AI assistants (ChatGPT, Claude, Copilot -- capable but isolated)
    - Personal computing vision (Alan Kay, Xerox PARC, Dynamicland)
    - Self-modifying systems (genetic programming, autopoiesis)
    - Agent frameworks (LangChain, CrewAI, Claude Agent SDK)
    - Federated protocols (Matrix, ActivityPub, Nostr)
  - **3. Architecture**: Core metaphor (CPU=Claude, RAM=context, Kernel=agent, etc.). Six principles. File-first design. Agent-as-kernel.
  - **4. Novel Paradigms**:
    - Living Software (apps that evolve from usage)
    - Socratic Computing (ask before building)
    - Intent-Based Interfaces (same intent, different renders)
    - Progressive Depth (Bruner's modes)
  - **5. Implementation**: Tech stack, test-driven development, 479 tests, phases completed.
  - **6. Web 4 Vision**: Federated identity, AI-to-AI, peer-to-peer sync, app marketplace.
  - **7. Evaluation**: What works, limitations, future work.
  - **8. Conclusion**

- [ ] T731 [US-WP1] Research citations:
  - Gather proper references for Related Work section
  - Format as footnotes or endnotes
  - Key references: Unix philosophy (McIlroy), Plan 9 (Pike), Alan Kay (Dynabook), Agent SDK docs, Matrix spec, Bruner's modes of representation

### Web Page

- [ ] T732 [US-WP1] Create `www/src/app/whitepaper/page.tsx`:
  - Clean, readable layout (max-w-3xl, good typography)
  - Table of contents sidebar (sticky on desktop)
  - Section navigation (anchor links)
  - Reading time estimate
  - Download PDF button
  - Share button (copy link)
  - Consistent with design guide (warm palette, rounded, clean)

### PDF

- [ ] T733 [US-WP1] PDF generation:
  - Option A: Use `@react-pdf/renderer` to generate PDF from React components
  - Option B: Print-optimized CSS on whitepaper page, browser "Print to PDF"
  - Option C: Pre-generate with Playwright `page.pdf()`
  - Recommend Option B (simplest, always in sync with web version)
  - Add `@media print` styles to whitepaper page
  - "Download PDF" button triggers `window.print()`

### Audio (Stretch)

- [ ] T734 [US-WP1] Audio version of whitepaper:
  - After T669 (ElevenLabs TTS)
  - Generate section-by-section audio files
  - Combine into single MP3 (or serve as playlist)
  - Audio player component on whitepaper page
  - Estimated: ~20 min audio for full whitepaper

### Navigation

- [ ] T735 [US-WP1] Add whitepaper to site navigation:
  - LP nav: add "Whitepaper" link
  - Footer: add "Whitepaper" link
  - Dashboard: add "Read the whitepaper" card
  - OG meta tags for sharing (title, description, image)

## Implications

- **Content quality matters more than formatting**. Judges read for substance. Focus on clear writing, real research references, honest evaluation.
- **Keep it concise**: aim for 3000-5000 words. Not a 50-page academic paper. More like a well-written blog post with depth.
- **Update-friendly**: since content is in a React component, easy to iterate. No build step for content changes.
- **SEO**: whitepaper page should be indexable, good for organic discovery.
- **Future**: expand into full docs site (architecture docs, API reference, tutorials) if project grows.

## Checkpoint

- [ ] `matrix-os.com/whitepaper` renders full whitepaper with TOC.
- [ ] PDF download works (browser print or generated).
- [ ] All sections written with real content (not placeholder).
- [ ] Navigation links added to LP, footer, dashboard.
