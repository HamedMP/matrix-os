---
title: Colors
description: Approved Matrix OS palette, semantic roles, and accessibility rules.
status: stable
source: Figma xPG2FeYRtC9owCKSVXCqWA, node 1:846
---

# Colors

## Core palette

| Name | Hex | RGB | Role |
| --- | --- | --- | --- |
| Teal | `#0E3422` | `14, 52, 34` | Identity, primary action, navigation |
| Coral | `#D06E53` | `208, 110, 83` | Attention, warmth, destructive emphasis |
| Gold | `#F1C379` | `241, 195, 121` | Focus, selection, optimistic emphasis |
| Green | `#BED77B` | `190, 215, 123` | Mark, success, ready states |
| Blue | `#C5D6E2` | `197, 214, 226` | Information, passive progress |

Teal anchors the composition. Use the supporting colors deliberately; a view
should not give all five equal visual weight.

## Full scales

| Step | Green | Teal | Coral | Gold | Blue | Neutral |
| ---: | --- | --- | --- | --- | --- | --- |
| 50 | `#F4F7ED` | `#EEF7F2` | `#FAEEEB` | `#FCF5E8` | `#EDF3F7` | `#FFFFFF` |
| 100 | `#E4EDD4` | `#C9E8D9` | `#F2D6CF` | `#FAEAD1` | `#C5D6E2` | `#F3F2F2` |
| 200 | `#CEE0AE` | `#97D8B9` | `#E6B5A8` | `#F6DAAC` | `#9DBFD7` | `#E1E0E0` |
| 300 | `#BED77B` | `#5EC996` | `#DA9481` | `#F1C379` | `#71A9D0` | `#C8C6C6` |
| 400 | `#9AC059` | `#34B275` | `#D06E53` | `#E0AA52` | `#5CA0D1` | `#A8A4A4` |
| 500 | `#748E59` | `#288A5B` | `#BA5236` | `#D2932D` | `#3B85BA` | `#827D7D` |
| 600 | `#62783A` | `#1B6541` | `#8F432D` | `#A37429` | `#306991` | `#635F5F` |
| 700 | `#475926` | `#13492F` | `#6B3324` | `#775622` | `#254D6A` | `#413E3E` |
| 800 | `#2B3715` | `#0E3422` | `#442118` | `#4D3919` | `#193143` | `#242323` |
| 900 | `#171F0A` | `#061810` | `#25130E` | `#251C0E` | `#0F1B24` | `#0D0C0C` |

## Semantic mapping

| Role | Value | Guidance |
| --- | --- | --- |
| Canvas | Green 50 `#F4F7ED` | Default page/background tint |
| Paper | `#FCFCF8` | Brand cards and primary surfaces |
| Elevated surface | Neutral 50 `#FFFFFF` | Menus, dialogs, raised content |
| Foreground | `#1F2D1D` | Primary ink |
| Muted foreground | Neutral 600 `#635F5F` | Secondary copy |
| Border | `#E0E1CA` | Quiet warm divider/border |
| Primary | Teal 800 `#0E3422` | Main controls and active navigation |
| Accent | Coral 400 `#D06E53` | Attention and warmth, not body text |
| Focus | Gold 300 `#F1C379` | Keyboard focus and selection ring |
| Success | Teal 500 `#288A5B` | Connected and completed |
| Warning | Gold 500 `#D2932D` | Pending and caution |
| Danger | Coral 500 `#BA5236` | Errors and destructive actions |
| Info | Blue 500 `#3B85BA` | Information and neutral progress |

## Accessibility

All body text and controls meet WCAG AA. State is never communicated by color
alone.

| Combination | Ratio | Result |
| --- | ---: | --- |
| Teal on paper | 13.32:1 | AAA |
| Ink on paper | 14.07:1 | AAA |
| Ink on Green | 9.09:1 | AAA |
| Teal on Blue | 9.19:1 | AAA |
| Coral on paper | 3.38:1 | Large text/non-text only |

Use Teal for small interactive text and button fills. Coral needs dark text or a
larger/non-text application after checking the exact pair.
