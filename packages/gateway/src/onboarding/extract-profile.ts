import { ExtractedProfileSchema, type ExtractedProfile } from "./types.js";

const EXTRACTION_PROMPT = `Extract the following structured information from this conversation transcript between an AI and a new user. Return ONLY valid JSON, no markdown.

Schema:
{
  "name": "user's name or how they'd like to be called",
  "role": "their primary role/profession",
  "interests": ["list of interests mentioned"],
  "painPoints": ["problems or frustrations they mentioned"],
  "workStyle": "how they described their work style",
  "apps": [{"name": "App Name", "description": "what it does"}],
  "personality": {"vibe": "communication style", "traits": ["personality traits"]}
}

For "apps", suggest 3-5 apps that would genuinely help this person based on what they said. If something wasn't mentioned, make reasonable inferences from context.`;

export async function extractProfile(
  transcript: string,
  apiKey: string,
  model = "gemini-2.5-flash",
): Promise<ExtractedProfile | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${EXTRACTION_PROMPT}\n\nTranscript:\n${transcript}` }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      console.error(`[extract] Gemini returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    const result = ExtractedProfileSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (err) {
    console.error("[extract] Failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
