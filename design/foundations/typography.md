---
title: Typography
description: Approved Matrix OS font families, type scale, and usage rules.
status: stable
source: Figma xPG2FeYRtC9owCKSVXCqWA, node 1:846
---

# Typography

## Families

| Role | Family | Use |
| --- | --- | --- |
| Display and headings | **Bricolage Grotesque** | Wordmark, hero text, product headings |
| Body and UI | **Geist** | Controls, navigation, forms, prose, labels |
| Code and machine voice | **Geist Mono** | Terminal, commands, paths, IDs, technical state |

The family roles are shared across web, desktop, and mobile. Native shells may
bundle the font differently, but must not substitute a platform-specific brand
voice.

### Bricolage Grotesque

Use for expressive hierarchy: wordmark, display, H1–H3, and short subtitles.
Keep long-form copy and dense controls in Geist.

### Geist

Use for all interface and reading text. Default to Regular 400 for prose,
Medium/SemiBold for control emphasis, and Bold 700 for short overlines.

### Geist Mono

Use when the content belongs to the machine: terminal output, commands, paths,
IDs, hashes, versions, and compact technical status. Do not use it merely to
make ordinary copy feel technical.

## Scale

| Style | Family | Size | Weight | Line height | Tracking |
| --- | --- | ---: | ---: | ---: | ---: |
| Display | Bricolage Grotesque | 72px | 800 | 110% | -2% |
| Heading 1 | Bricolage Grotesque | 48px | 700 | 115% | -1% |
| Heading 2 | Bricolage Grotesque | 36px | 600 | 120% | -0.5% |
| Heading 3 | Bricolage Grotesque | 28px | 500 | 125% | 0 |
| Subtitle | Bricolage Grotesque | 22px | 500 | 140% | 0 |
| Body large | Geist | 18px | 400 | 155% | 0 |
| Body | Geist | 16px | 400 | 160% | 0.5% |
| Body small | Geist | 14px | 400 | 160% | 1% |
| Caption | Geist | 12px | 400 | 150% | 1.5% |
| Overline / label | Geist | 11px | 700 | 130% | 3px |
| Machine | Geist Mono | 14px | 400 | 150% | 0 |

## Responsive use

- Display and H1 may use `clamp()` to reach the specified desktop size.
- H1 should generally resolve to 34–40px on a phone; H2 to 28–32px.
- Body text stays 16px for reading surfaces and never drops below 14px for UI.
- Use uppercase only for short overlines and labels.
- Avoid center-aligned body copy longer than two lines.
- Preserve hierarchy rather than matching line breaks across form factors.

## Font loading

- Load only the weights used by the current surface.
- Use variable font files where supported.
- Prevent synthetic bold and italic styles.
- Keep fallback stacks metric-compatible enough to avoid layout shifts.
- Terminal/editor font preferences are product settings; the branded machine
  voice around those surfaces remains Geist Mono.
