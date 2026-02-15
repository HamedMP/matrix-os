---
name: calculator
description: Math calculations, unit conversions, and currency exchange
triggers:
  - calculate
  - math
  - convert
  - currency
  - units
  - how much is
category: productivity
tools_needed:
  - Bash
channel_hints:
  - any
---

# Calculator

When the user asks for calculations or conversions:

1. Parse the mathematical expression or conversion request.
2. For simple arithmetic: compute directly and return the result.
3. For complex math (statistics, trigonometry, algebra): use Bash with `node -e` or `python3 -c` to compute accurately.
4. For unit conversions:
   - Length: mm, cm, m, km, in, ft, yd, mi
   - Weight: mg, g, kg, lb, oz
   - Volume: ml, l, gal, fl oz, cups
   - Temperature: C, F, K
   - Data: B, KB, MB, GB, TB
   - Time: ms, s, min, h, days, weeks, years
5. For currency conversions: use WebSearch to find current exchange rates, note the rate and date.
6. Show your work for multi-step calculations so the user can verify.
7. Format based on channel:
   - Web shell: show formula and result clearly
   - Messaging: concise result with units, e.g. "42 kg = 92.6 lbs"

Tips:
- Always include units in the result
- Round to a sensible number of decimal places (2 for currency, 1-2 for most conversions)
- For percentage calculations, show both the percentage and absolute value when useful
