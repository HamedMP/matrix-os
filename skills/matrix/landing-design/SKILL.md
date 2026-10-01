---
triggers: ["public landing page", "marketing site", "Matrix website"]
name: matrix-landing-design
description: Build product-specific landing pages with a clear promise, authentic product previews, Matrix theme integration, working CTAs, accessible motion, and rendered verification.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
related_skills: [matrix-app-builder, matrix-design-system, emil-design-eng, animate]
metadata:
  agent:
    tags: [Matrix OS, landing page, marketing, hero, brand, website]
    related_skills: [matrix-app-builder, matrix-design-system, emil-design-eng, animate]
---

# Matrix Landing Page Design

## Selection boundary

Use for product landing pages and marketing surfaces, including a landing page for a user-built Matrix app. For the working product interface use `matrix-app-ui-patterns`. Read `matrix-app-builder` for runtime/manifest/bridge requirements; this skill does not change them. Read `matrix-design-system`, `emil-design-eng`, and the relevant `animate` resources for theme and interaction craft.

## Establish direction

Read the user's references, existing product, and DESIGN.md before designing. Record the audience, actual product promise, primary CTA, visual direction, typography, spacing, imagery, responsive layout, and motion. Choose a coherent default when the brief is clear. Offer alternatives only when requested or a real unresolved choice affects the outcome.

A planner can be quiet and precise; a finance journal can emphasize readable figures; a creative studio can be editorial and expressive. The product and audience determine the composition. Do not turn every page into the same centered hero, decorative cards, grain overlay, glowing gradient, or pill-button template.

## Brand and typography

Inside Matrix, use inherited `--matrix-*` tokens as a baseline, with readable local fallbacks. Follow the product’s selected visual family, mood and palette through app-local semantic tokens; bright minimalism, bold neo-brutalism, playful retro or soft neumorphism can shape the entire page. The shared current Matrix brand uses Bricolage Grotesque for display, Geist for body/UI and Geist Mono for code; use fonts already bundled/injected rather than remote font stylesheets. A user-supplied product direction may shape display composition and illustration while keeping focus, controls, and system integration coherent.

For Matrix platform auth/onboarding/billing or public-site work, consume `@matrix-os/brand` tokens and primitives from the actual repository; do not invent another brand helper. Ordinary generated apps retain installed theme/bridge integration and can express their own product style without importing an unavailable platform package.

Use a deliberate type scale, readable measure, generous but purposeful whitespace, and meaningful contrast. Long headings must wrap well at narrow widths. Eyebrows and section numbers are optional; do not use tiny low-contrast uppercase labels for essential information.

## Compose around the actual product

1. Lead with a concrete promise and clear primary action.
2. Show authentic product UI or an explicitly labeled conceptual illustration. Prefer a real app screenshot or a faithful local preview over an invented dashboard.
3. Explain the core workflow with enough detail to understand the benefit. Use the real feature set; do not invent sync, collaboration, AI, banking, or pricing capabilities.
4. Add relevant proof only when supplied and verified. Never fabricate testimonials, customer counts, ratings, logos, savings, or performance claims.
5. End with a working CTA and useful navigation/contact information where provided.

Vary section layout to match content: an editorial narrative, product walkthrough, comparison, or focused feature panel. Cards, alternating dark bands, asymmetric layouts, textures and gradients are options, not requirements. Use imagery only when it helps the promise. Bundle local imagery/icons; avoid stock decorations and remote CDN dependencies.

A landing page for a Matrix app should use `window.MatrixOS.openApp(displayName, appPath): void`, with both values from the discovered installed app. This requests a shell launch and returns no confirmation of success; verify the opened app separately. Guard for an absent bridge with a clear state or supported link. Navigation anchors must resolve; simulated signup/purchase must be labeled and must not collect personal data or pretend a service exists.

## Interaction and motion

Motion should establish hierarchy, explain continuity, or confirm an action. Read the chosen motion skill and record purpose/duration/easing in DESIGN.md.

- Keep CTAs, keyboard focus, scrolling and repeated actions immediately usable.
- Prefer short opacity/transform transitions. Avoid obligatory long entrance staggers that delay the product or move everything on every visit.
- Do not continuously float the product preview, autoplay decorative media, hijack scrolling, or hide essential content until an observer fires.
- Use native links/buttons, visible focus, generous touch targets, and no hover-only behavior.
- Respect `prefers-reduced-motion`: remove entrance transforms, smooth scrolling and ornamental motion while preserving content and feedback.
- Avoid `transition: all`, expensive full-page blur effects, and layout animation on frequently edited controls.

## Responsive and content states

Read [Responsive layout and verification](../app-builder/references/responsive-layout.md). Apply its container-width composition and multi-width checks to the landing page and its working product; keep primary CTA, compact navigation, keyboard focus and touch controls accessible.

Design for both wide and narrow Matrix windows. Use flexible grids and fluid type/spacing; collapse navigation before it crowds the CTA. Make long product names, headings, and labels wrap. Avoid fixed-height hero clipping or body overflow locks on scrolling pages.

Use safe contrast in light/dark themes, readable screenshots, descriptive image alternatives, and semantic landmarks/headings. Loading imagery needs a stable aspect ratio. A missing preview, bridge, or asset should show an honest usable fallback; never a broken image or dead button.

## Verify and refine

Build and run the app-builder manifest verifier. Open the page in Matrix and inspect it alongside the actual app. Check wide/narrow rendering, scroll/anchor navigation, primary CTA, keyboard focus, touch use, themes, reduced motion, assets, and console errors using tools actually available.

Capture rendered screenshots and improve the largest issues in hierarchy, spacing, type wrapping, imagery, or interaction. If using conceptual UI, label it; if testing outside Matrix, do not claim sandbox/bridge success. Report app paths, actual tested surfaces, working actions, and pending checks. A build alone does not prove design quality.
