---
name: screenshot
description: Take screenshots of URLs or web pages
triggers:
  - screenshot
  - capture page
  - snap
  - webpage image
category: media
tools_needed:
  - browse_web
channel_hints:
  - web
---

# Screenshot

When the user asks to take a screenshot:

NOTE: This skill requires the `browse_web` IPC tool (from spec 019-browser). If the tool is not available, inform the user that screenshots are not yet enabled.

## When the Tool Is Available
1. Determine the target:
   - URL: navigate to the URL and capture
   - App name: find the app's URL from modules.json and capture
   - "Current page": capture the active window context
2. Call `browse_web` with action "screenshot" and the target URL.
3. Save the result to `~/data/screenshots/<descriptive-name>-<timestamp>.png`.
4. Present the screenshot to the user.

## Options
- Full page vs. viewport only (default: viewport)
- Specific element selector (if the user wants just a section)
- Delay before capture (for pages that need time to load)
- Device emulation (mobile, tablet, desktop widths)

## When the Tool Is Not Available
1. Acknowledge the request.
2. Explain that the browser tool is not yet configured.
3. If the user just needs to see a webpage, suggest using `web-search` to fetch and summarize the content instead.
