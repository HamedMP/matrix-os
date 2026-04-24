import type { ContextualContent } from "./types.js";

/**
 * Builds up a profile by accumulating the full conversation transcript
 * and running pattern detection against the accumulated text.
 * Transcripts arrive as tiny fragments — we must match against the whole thing.
 */
export function createProfileBuilder() {
  const profile: { name?: string; role?: string; interests: string[] } = { interests: [] };
  let lastEmitJson = "";
  let fullUserTranscript = "";
  let fullAiTranscript = "";

  function tryExtract(): ContextualContent | null {
    let changed = false;

    // Extract name from AI transcript (AI repeating user's name back)
    if (!profile.name) {
      const aiNamePatterns = [
        /(?:nice to meet you|hey|hi|cool|great|awesome|alright),?\s+(\w+)/gi,
        /welcome,?\s+(\w+)/gi,
        /(?:nice|good) to (?:meet|know) you,?\s+(\w+)/gi,
      ];
      for (const pat of aiNamePatterns) {
        const matches = [...fullAiTranscript.matchAll(pat)];
        const match = matches.at(-1); // last occurrence
        if (match && match[1].length > 1 && match[1].length < 20) {
          const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
          // Skip common words that aren't names
          const skipWords = new Set(["there", "everyone", "guys", "all", "welcome", "sure", "yeah", "nice", "well", "so", "now", "what", "how", "that"]);
          if (!skipWords.has(name.toLowerCase())) {
            profile.name = name;
            changed = true;
          }
        }
      }
    }

    // Also try to extract name from user transcript ("my name is X", "I'm X", "it's X", "this is X")
    if (!profile.name) {
      const userNamePatterns = [
        /(?:my name is|i'm|i am|it's|this is|call me)\s+(\w+)/gi,
      ];
      for (const pat of userNamePatterns) {
        const matches = [...fullUserTranscript.matchAll(pat)];
        const match = matches.at(-1);
        if (match && match[1].length > 1 && match[1].length < 20) {
          const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
          const skipWords = new Set(["a", "an", "the", "just", "really", "very", "so", "not", "here", "interested"]);
          if (!skipWords.has(name.toLowerCase())) {
            profile.name = name;
            changed = true;
          }
        }
      }
    }

    // Extract role from user transcript
    if (!profile.role) {
      const rolePatterns = [
        /i(?:'m| am) (?:a |an )?(.+?)(?:\.|,|!|\?|and |but |so |$)/gi,
        /i work (?:as |in |at |on |with )(.+?)(?:\.|,|!|\?|and |but |$)/gi,
        /i do (.+?)(?:\.|,|!|\?|$)/gi,
      ];
      for (const pat of rolePatterns) {
        const matches = [...fullUserTranscript.matchAll(pat)];
        const match = matches.at(-1);
        if (match && match[1].length > 2 && match[1].length < 60) {
          const role = match[1].trim();
          // Skip non-role phrases
          const skipPhrases = ["here", "good", "fine", "excited", "interested", "curious", "looking", "trying", "going"];
          if (!skipPhrases.some((s) => role.toLowerCase().startsWith(s))) {
            profile.role = role;
            changed = true;
          }
        }
      }
    }

    // Extract interests
    const interestPatterns = [
      /i(?:'m| am) (?:interested in|into|passionate about|really into)\s+(.+?)(?:\.|,|!|\?|$)/gi,
      /i (?:like|love|enjoy|use)\s+(.+?)(?:\.|,|!|\?|$)/gi,
    ];
    for (const pat of interestPatterns) {
      for (const match of fullUserTranscript.matchAll(pat)) {
        if (match[1].length > 2 && match[1].length < 50) {
          const interest = match[1].trim();
          if (!profile.interests.includes(interest)) {
            profile.interests.push(interest);
            changed = true;
          }
        }
      }
    }

    if (!changed) return null;
    return emit();
  }

  function emit(): ContextualContent | null {
    if (!profile.name && !profile.role && profile.interests.length === 0) return null;

    const json = JSON.stringify(profile);
    if (json === lastEmitJson) return null;
    lastEmitJson = json;

    return {
      kind: "profile_info",
      fields: {
        name: profile.name,
        role: profile.role,
        interests: profile.interests.length > 0 ? [...profile.interests] : undefined,
      },
    };
  }

  return {
    onAiTranscript(text: string): ContextualContent | null {
      fullAiTranscript += " " + text;
      return tryExtract();
    },

    onUserTranscript(text: string): ContextualContent | null {
      fullUserTranscript += " " + text;
      return tryExtract();
    },
  };
}
