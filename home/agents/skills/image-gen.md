---
name: image-gen
description: Generate images from text descriptions using AI
triggers:
  - generate image
  - create image
  - draw
  - picture of
  - illustration
  - make an image
category: media
tools_needed:
  - generate_image
channel_hints:
  - web
---

# Image Generation

When the user asks to generate an image:

NOTE: This skill requires the `generate_image` IPC tool (from spec 017-media). If the tool is not available, inform the user that image generation is not yet enabled and suggest describing what they want for when it becomes available.

## When the Tool Is Available
1. Parse the user's description into a clear prompt.
2. Enhance the prompt for better results:
   - Add style descriptors if not specified (photorealistic, illustration, pixel art, etc.)
   - Add composition hints (close-up, wide shot, overhead view)
   - Add lighting and mood descriptors when relevant
3. Call `generate_image` with the enhanced prompt.
4. Save the result to `~/data/images/<descriptive-name>.png`.
5. Present the image to the user with the final prompt used.

## Prompt Engineering Tips
- Be specific: "a golden retriever puppy playing in autumn leaves, warm sunlight" over "a dog"
- Specify style early: "oil painting of..." or "minimalist vector illustration of..."
- Include negative terms for what to avoid if needed
- For consistency across images, reuse style descriptors

## When the Tool Is Not Available
1. Acknowledge the request.
2. Explain that image generation is not yet configured.
3. Save the prompt to `~/data/images/pending-requests.md` so it can be generated later.
4. Suggest the user check back after the media module is enabled.
