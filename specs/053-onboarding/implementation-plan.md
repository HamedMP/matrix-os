# Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a voice-first onboarding flow where Gemini Live interviews new users, then they claim a username and add an API key (or choose Claude Code mode).

**Architecture:** Gateway `/ws/onboarding` relays audio between browser and Gemini Live API. Browser captures PCM16 at 16kHz via AudioWorklet, Gemini returns PCM16 at 24kHz -- gateway just relays base64, no transcoding. State machine tracks stages. Shell renders fullscreen onboarding screen with voice orb.

**Tech Stack:** Gemini Multimodal Live API (`gemini-3.1-flash-live-preview`), Hono WebSocket (`upgradeWebSocket`), Zod 4, React 19, Web Audio API + AudioWorklet, xterm.js (existing Terminal)

**Reference code:** `/Users/hamed/dev/playgrounds/finna-deepmind-granola-hackathon/apps/web/src/components/voice/` -- working Gemini Live implementation

---

## File Map

### New Files (Gateway)
| File | Responsibility |
|------|---------------|
| `packages/gateway/src/onboarding/types.ts` | Zod schemas for all WS messages, stage enum, error codes |
| `packages/gateway/src/onboarding/state-machine.ts` | Stage transitions, per-stage timeouts, state persistence |
| `packages/gateway/src/onboarding/gemini-live.ts` | Gemini Live WebSocket client, audio relay, transcript buffer |
| `packages/gateway/src/onboarding/ws-handler.ts` | `/ws/onboarding` endpoint, orchestrates state machine + Gemini |
| `packages/gateway/src/onboarding/extract-profile.ts` | Post-interview structured extraction via Gemini REST API |
| `packages/gateway/src/onboarding/username.ts` | Display name validation, write to handle.json |
| `packages/gateway/src/onboarding/api-key.ts` | Format check, Anthropic API validation, secure storage |

### New Files (Shell)
| File | Responsibility |
|------|---------------|
| `shell/src/hooks/useOnboarding.ts` | WS connection, audio capture/playback, state exposure |
| `shell/src/components/OnboardingScreen.tsx` | Fullscreen takeover, stage-aware rendering |
| `shell/src/components/onboarding/VoiceOrb.tsx` | Animated orb (listening/speaking/thinking states) |
| `shell/src/components/onboarding/AppSuggestionCards.tsx` | Toggle-able app cards |
| `shell/src/components/onboarding/UsernameInput.tsx` | Display name input with validation |
| `shell/src/components/onboarding/ActivationChoice.tsx` | Three-path choice (API key / Claude Code / Credits) |
| `shell/src/components/onboarding/ApiKeyInput.tsx` | Masked paste input with validation |
| `shell/public/audio-worklet-processor.js` | PCM16 encoder for mic capture |

### New Files (Tests)
| File | Covers |
|------|--------|
| `tests/gateway/onboarding/state-machine.test.ts` | Transitions, timeouts, persistence, resume |
| `tests/gateway/onboarding/username.test.ts` | Display name validation |
| `tests/gateway/onboarding/api-key.test.ts` | Format, validation, error stripping |
| `tests/gateway/onboarding/extract-profile.test.ts` | Schema mapping, fallback |
| `tests/gateway/onboarding/gemini-live.test.ts` | Connection, message parsing, reconnect |
| `tests/gateway/onboarding/ws-handler.test.ts` | Full flow with mocked Gemini |

### Modified Files
| File | Change |
|------|--------|
| `packages/gateway/src/server.ts` | Register `/ws/onboarding` |
| `packages/gateway/src/auth.ts` | Add `/ws/onboarding` to `WS_QUERY_TOKEN_PATHS` |
| `packages/kernel/src/onboarding.ts` | Migrate `writeSetupPlan` to async |
| `packages/gateway/src/dispatcher.ts` | Read BYOK key from config per dispatch |
| `packages/platform/src/main.ts` | Session-based routing for `app.matrix-os.com` |
| `www/src/app/dashboard/actions.ts` | Redirect to `app.matrix-os.com` after provisioning |
| `shell/src/components/Desktop.tsx` | First-run detection |
| `home/CLAUDE.md` | Add skills/knowledge references |
| `distro/cloudflared.yml` | Add `app.matrix-os.com` route |

---

### Task 1: Shared Protocol Types

**Files:**
- Create: `packages/gateway/src/onboarding/types.ts`
- Test: `tests/gateway/onboarding/types.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/gateway/onboarding/types.test.ts
import { describe, it, expect } from "vitest";
import {
  OnboardingStage,
  ShellToGatewaySchema,
  GatewayToShellSchema,
  STAGE_TIMEOUTS,
} from "../../packages/gateway/src/onboarding/types.js";

describe("onboarding types", () => {
  it("validates start message", () => {
    const msg = { type: "start", audioFormat: "pcm16" };
    expect(ShellToGatewaySchema.safeParse(msg).success).toBe(true);
  });

  it("validates text start message", () => {
    const msg = { type: "start", audioFormat: "text" };
    expect(ShellToGatewaySchema.safeParse(msg).success).toBe(true);
  });

  it("rejects invalid audio format", () => {
    const msg = { type: "start", audioFormat: "mp3" };
    expect(ShellToGatewaySchema.safeParse(msg).success).toBe(false);
  });

  it("validates claim_username message", () => {
    const msg = { type: "claim_username", username: "hamed123" };
    expect(ShellToGatewaySchema.safeParse(msg).success).toBe(true);
  });

  it("validates choose_activation message", () => {
    const msg = { type: "choose_activation", path: "api_key" };
    expect(ShellToGatewaySchema.safeParse(msg).success).toBe(true);
  });

  it("validates stage message with audioSource", () => {
    const msg = { type: "stage", stage: "greeting", audioSource: "gemini_live" };
    expect(GatewayToShellSchema.safeParse(msg).success).toBe(true);
  });

  it("validates error message", () => {
    const msg = { type: "error", code: "stage_timeout", stage: "interview", message: "Timed out", retryable: false };
    expect(GatewayToShellSchema.safeParse(msg).success).toBe(true);
  });

  it("has timeout for every stage", () => {
    const stages: OnboardingStage[] = ["greeting", "interview", "extract_profile", "suggest_apps", "claim_username", "activation", "api_key", "provisioning"];
    for (const stage of stages) {
      expect(STAGE_TIMEOUTS[stage]).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run test tests/gateway/onboarding/types.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement types**

```typescript
// packages/gateway/src/onboarding/types.ts
import { z } from "zod/v4";

export const ONBOARDING_STAGES = [
  "greeting", "interview", "extract_profile", "suggest_apps",
  "claim_username", "activation", "api_key", "provisioning", "done",
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const STAGE_TIMEOUTS: Record<Exclude<OnboardingStage, "done">, number> = {
  greeting: 60_000,
  interview: 600_000,
  extract_profile: 30_000,
  suggest_apps: 120_000,
  claim_username: 300_000,
  activation: 300_000,
  api_key: 300_000,
  provisioning: 600_000,
};

export const ACTIVATION_PATHS = ["api_key", "claude_code", "credits"] as const;
export type ActivationPath = (typeof ACTIVATION_PATHS)[number];

export const ERROR_CODES = [
  "gemini_unavailable", "stage_timeout", "username_taken", "api_key_invalid",
  "provisioning_failed", "connection_limit", "audio_error",
] as const;

// Shell -> Gateway messages
export const ShellToGatewaySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), audioFormat: z.enum(["pcm16", "text"]) }),
  z.object({ type: z.literal("audio"), data: z.string() }),
  z.object({ type: z.literal("text_input"), text: z.string() }),
  z.object({ type: z.literal("claim_username"), username: z.string() }),
  z.object({ type: z.literal("choose_activation"), path: z.enum(ACTIVATION_PATHS) }),
  z.object({ type: z.literal("set_api_key"), apiKey: z.string() }),
  z.object({
    type: z.literal("confirm_apps"),
    apps: z.array(z.string()).max(10),
  }),
]);
export type ShellToGateway = z.infer<typeof ShellToGatewaySchema>;

// Gateway -> Shell messages
export const GatewayToShellSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stage"),
    stage: z.enum(ONBOARDING_STAGES),
    audioSource: z.enum(["gemini_live", "tts"]).optional(),
    apps: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
    paths: z.array(z.enum(ACTIVATION_PATHS)).optional(),
  }),
  z.object({ type: z.literal("audio"), data: z.string() }),
  z.object({ type: z.literal("transcript"), text: z.string(), speaker: z.enum(["ai", "user"]) }),
  z.object({ type: z.literal("mode_change"), mode: z.enum(["text", "voice"]) }),
  z.object({ type: z.literal("username_result"), saved: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("api_key_result"), valid: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("onboarding_already_complete") }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    stage: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);
export type GatewayToShell = z.infer<typeof GatewayToShellSchema>;

// Persisted state for resume
export interface OnboardingState {
  currentStage: OnboardingStage;
  completedStages: OnboardingStage[];
  transcript: string;
  extractedProfile: ExtractedProfile | null;
  suggestedApps: Array<{ name: string; description: string }>;
  claimedUsername: string | null;
  activationPath: ActivationPath | null;
  updatedAt: string;
}

export interface ExtractedProfile {
  name: string;
  role: string;
  interests: string[];
  painPoints: string[];
  workStyle: string;
  apps: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
  personality: { vibe: string; traits: string[] };
}

export const ExtractedProfileSchema = z.object({
  name: z.string(),
  role: z.string(),
  interests: z.array(z.string()),
  painPoints: z.array(z.string()),
  workStyle: z.string(),
  apps: z.array(z.object({ name: z.string(), description: z.string() })),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  personality: z.object({ vibe: z.string(), traits: z.array(z.string()) }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run test tests/gateway/onboarding/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/types.ts tests/gateway/onboarding/types.test.ts
git commit -m "feat(onboarding): add shared protocol types and Zod schemas"
```

---

### Task 2: Onboarding State Machine

**Files:**
- Create: `packages/gateway/src/onboarding/state-machine.ts`
- Test: `tests/gateway/onboarding/state-machine.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/gateway/onboarding/state-machine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStateMachine } from "../../packages/gateway/src/onboarding/state-machine.js";
import type { OnboardingStage } from "../../packages/gateway/src/onboarding/types.js";

describe("onboarding state machine", () => {
  let sm: ReturnType<typeof createStateMachine>;

  beforeEach(() => {
    sm = createStateMachine();
  });

  it("starts at greeting stage", () => {
    expect(sm.current).toBe("greeting");
  });

  it("transitions greeting -> interview", () => {
    sm.transition("interview");
    expect(sm.current).toBe("interview");
    expect(sm.completed).toContain("greeting");
  });

  it("rejects invalid transition", () => {
    expect(() => sm.transition("api_key")).toThrow();
  });

  it("follows full happy path", () => {
    const stages: OnboardingStage[] = [
      "interview", "extract_profile", "suggest_apps",
      "claim_username", "activation", "api_key", "provisioning", "done",
    ];
    for (const stage of stages) {
      sm.transition(stage);
    }
    expect(sm.current).toBe("done");
    expect(sm.completed).toHaveLength(8);
  });

  it("allows activation -> done (Path B: claude_code)", () => {
    sm.transition("interview");
    sm.transition("extract_profile");
    sm.transition("suggest_apps");
    sm.transition("claim_username");
    sm.transition("activation");
    sm.transition("done"); // skip api_key + provisioning
    expect(sm.current).toBe("done");
  });

  it("serializes and restores state", () => {
    sm.transition("interview");
    sm.transition("extract_profile");
    const snapshot = sm.serialize();

    const restored = createStateMachine(snapshot);
    expect(restored.current).toBe("extract_profile");
    expect(restored.completed).toContain("greeting");
    expect(restored.completed).toContain("interview");
  });

  it("emits stage timeout callback", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    sm = createStateMachine(undefined, { onTimeout });

    sm.startTimer();
    vi.advanceTimersByTime(60_001); // greeting timeout is 60s
    expect(onTimeout).toHaveBeenCalledWith("greeting");

    vi.useRealTimers();
  });

  it("resets timer on transition", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    sm = createStateMachine(undefined, { onTimeout });

    sm.startTimer();
    vi.advanceTimersByTime(50_000); // 50s into greeting (60s timeout)
    sm.transition("interview");
    sm.startTimer();
    vi.advanceTimersByTime(50_000); // 50s into interview (600s timeout)
    expect(onTimeout).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/state-machine.test.ts`

- [ ] **Step 3: Implement state machine**

```typescript
// packages/gateway/src/onboarding/state-machine.ts
import { type OnboardingStage, STAGE_TIMEOUTS } from "./types.js";

const VALID_TRANSITIONS: Record<OnboardingStage, OnboardingStage[]> = {
  greeting: ["interview"],
  interview: ["extract_profile"],
  extract_profile: ["suggest_apps"],
  suggest_apps: ["claim_username"],
  claim_username: ["activation"],
  activation: ["api_key", "done"], // done = Path B/C skip
  api_key: ["provisioning"],
  provisioning: ["done"],
  done: [],
};

export interface StateMachineSnapshot {
  current: OnboardingStage;
  completed: OnboardingStage[];
}

interface StateMachineOptions {
  onTimeout?: (stage: OnboardingStage) => void;
}

export function createStateMachine(
  snapshot?: StateMachineSnapshot,
  opts?: StateMachineOptions,
) {
  let current: OnboardingStage = snapshot?.current ?? "greeting";
  let completed: OnboardingStage[] = snapshot?.completed ? [...snapshot.completed] : [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function transition(next: OnboardingStage) {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${current} -> ${next}`);
    }
    completed.push(current);
    current = next;
    clearTimer();
  }

  function startTimer() {
    clearTimer();
    if (current === "done") return;
    const timeout = STAGE_TIMEOUTS[current];
    timer = setTimeout(() => {
      opts?.onTimeout?.(current);
    }, timeout);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function serialize(): StateMachineSnapshot {
    return { current, completed: [...completed] };
  }

  return {
    get current() { return current; },
    get completed() { return [...completed]; },
    transition,
    startTimer,
    clearTimer,
    serialize,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/onboarding/state-machine.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/state-machine.ts tests/gateway/onboarding/state-machine.test.ts
git commit -m "feat(onboarding): add state machine with timeouts and serialization"
```

---

### Task 3: Username (Display Name) Handling

Username is cosmetic -- written to `~/system/handle.json`, not used for routing. All users access `app.matrix-os.com` and are routed by Clerk session.

**Files:**
- Create: `packages/gateway/src/onboarding/username.ts`
- Test: `tests/gateway/onboarding/username.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/gateway/onboarding/username.test.ts
import { describe, it, expect } from "vitest";
import { validateDisplayName } from "../../packages/gateway/src/onboarding/username.js";

describe("validateDisplayName", () => {
  it("accepts valid 3+ char name", () => {
    expect(validateDisplayName("hamed")).toEqual({ valid: true });
  });

  it("rejects short names", () => {
    const r = validateDisplayName("ab");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/3/);
  });

  it("accepts hyphens in the middle", () => {
    expect(validateDisplayName("my-name").valid).toBe(true);
  });

  it("rejects special characters", () => {
    expect(validateDisplayName("hamed@1").valid).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(validateDisplayName("-hamed").valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/username.test.ts`

- [ ] **Step 3: Implement display name validation and storage**

```typescript
// packages/gateway/src/onboarding/username.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function validateDisplayName(name: string): { valid: true } | { valid: false; error: string } {
  if (name.length < 3) {
    return { valid: false, error: "Must be at least 3 characters" };
  }
  const lower = name.toLowerCase();
  if (!HANDLE_RE.test(lower) && lower.length > 1) {
    return { valid: false, error: "Lowercase letters, numbers, and hyphens only" };
  }
  return { valid: true };
}

export async function saveHandle(homePath: string, handle: string, displayName?: string): Promise<void> {
  const handleData = {
    handle: handle.toLowerCase(),
    aiHandle: `${handle.toLowerCase()}_ai`,
    displayName: displayName ?? handle,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(homePath, "system", "handle.json"), JSON.stringify(handleData, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/onboarding/username.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/username.ts tests/gateway/onboarding/username.test.ts
git commit -m "feat(onboarding): add display name validation and handle.json storage"
```

---

### Task 4: API Key Validation

**Files:**
- Create: `packages/gateway/src/onboarding/api-key.ts`
- Test: `tests/gateway/onboarding/api-key.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/gateway/onboarding/api-key.test.ts
import { describe, it, expect, vi } from "vitest";
import { validateApiKeyFormat, validateApiKeyLive } from "../../packages/gateway/src/onboarding/api-key.js";

describe("validateApiKeyFormat", () => {
  it("accepts sk-ant- prefix", () => {
    expect(validateApiKeyFormat("sk-ant-api03-abc123")).toEqual({ valid: true });
  });

  it("rejects empty string", () => {
    expect(validateApiKeyFormat("").valid).toBe(false);
  });

  it("rejects wrong prefix", () => {
    expect(validateApiKeyFormat("sk-openai-123").valid).toBe(false);
  });
});

describe("validateApiKeyLive", () => {
  it("returns valid for 200 response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const result = await validateApiKeyLive("sk-ant-api03-valid");
    expect(result.valid).toBe(true);
  });

  it("returns invalid for 401 response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({ error: { message: "invalid x]" } }) });
    const result = await validateApiKeyLive("sk-ant-api03-bad");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Key validation failed");
  });

  it("strips API key from timeout errors", async () => {
    const error = new Error("Request with sk-ant-api03-secret failed");
    global.fetch = vi.fn().mockRejectedValue(error);
    const result = await validateApiKeyLive("sk-ant-api03-secret");
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain("sk-ant");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/api-key.test.ts`

- [ ] **Step 3: Implement API key validation**

```typescript
// packages/gateway/src/onboarding/api-key.ts
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export function validateApiKeyFormat(key: string): { valid: true } | { valid: false; error: string } {
  if (!key || !key.startsWith("sk-ant-")) {
    return { valid: false, error: "Key must start with sk-ant-" };
  }
  return { valid: true };
}

export async function validateApiKeyLive(key: string): Promise<{ valid: true } | { valid: false; error: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { valid: true };
    // 4xx = invalid key, 5xx = Anthropic issue
    const status = res.status;
    console.error(`[api-key] Validation returned HTTP ${status}`);
    return { valid: false, error: "Key validation failed" };
  } catch (err) {
    // Strip any API key from error message before logging
    const msg = err instanceof Error ? err.message.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]") : "Unknown error";
    console.error(`[api-key] Validation error: ${msg}`);
    return { valid: false, error: "Key validation failed" };
  }
}

export async function storeApiKey(homePath: string, apiKey: string): Promise<void> {
  const configPath = join(homePath, "system", "config.json");
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    // fresh config
  }
  const kernel = (config.kernel as Record<string, unknown>) ?? {};
  kernel.anthropicApiKey = apiKey;
  config.kernel = kernel;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/onboarding/api-key.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/api-key.ts tests/gateway/onboarding/api-key.test.ts
git commit -m "feat(onboarding): add API key validation with secure error handling"
```

---

### Task 5: Gemini Live Client

**Files:**
- Create: `packages/gateway/src/onboarding/gemini-live.ts`
- Test: `tests/gateway/onboarding/gemini-live.test.ts`

- [ ] **Step 1: Write the test file**

Test the message parsing and event emission. Mock WebSocket since we can't connect to Gemini in tests.

```typescript
// tests/gateway/onboarding/gemini-live.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseGeminiMessage, buildSetupMessage, GEMINI_SYSTEM_INSTRUCTION } from "../../packages/gateway/src/onboarding/gemini-live.js";

describe("buildSetupMessage", () => {
  it("builds valid setup with model and system instruction", () => {
    const msg = buildSetupMessage("gemini-3.1-flash-live-preview");
    expect(msg.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(msg.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(msg.setup.systemInstruction.parts[0].text).toBe(GEMINI_SYSTEM_INSTRUCTION);
    expect(msg.setup.outputAudioTranscription).toEqual({});
    expect(msg.setup.inputAudioTranscription).toEqual({});
  });
});

describe("parseGeminiMessage", () => {
  it("parses setupComplete", () => {
    const result = parseGeminiMessage({ setupComplete: true });
    expect(result).toEqual({ type: "setup_complete" });
  });

  it("parses audio output", () => {
    const result = parseGeminiMessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "base64audio" } }] } },
    });
    expect(result).toEqual({ type: "audio", data: "base64audio" });
  });

  it("parses input transcript", () => {
    const result = parseGeminiMessage({
      serverContent: { inputTranscription: { text: "hello" } },
    });
    expect(result).toEqual({ type: "input_transcript", text: "hello" });
  });

  it("parses output transcript", () => {
    const result = parseGeminiMessage({
      serverContent: { outputTranscription: { text: "hi there" } },
    });
    expect(result).toEqual({ type: "output_transcript", text: "hi there" });
  });

  it("parses turn complete", () => {
    const result = parseGeminiMessage({
      serverContent: { turnComplete: true },
    });
    expect(result).toEqual({ type: "turn_complete" });
  });

  it("parses interrupted", () => {
    const result = parseGeminiMessage({
      serverContent: { interrupted: true },
    });
    expect(result).toEqual({ type: "interrupted" });
  });

  it("returns null for unknown message", () => {
    expect(parseGeminiMessage({ unknown: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/gemini-live.test.ts`

- [ ] **Step 3: Implement Gemini Live client**

```typescript
// packages/gateway/src/onboarding/gemini-live.ts
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const GEMINI_SYSTEM_INSTRUCTION = `You are the voice of Matrix OS, meeting a new user for the first time. Be warm, curious, and conversational -- like a new friend, not a form. Learn about them naturally: what they do, what problems they deal with, how they like to work, what kind of AI personality would suit them. Don't ask rapid-fire questions. React to what they say, be genuinely interested. When you feel you have a good picture (usually 2-5 minutes), let them know you have some ideas for what to build them, and wrap up the conversation naturally.`;

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function buildSetupMessage(model: string) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }],
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          prefixPaddingMs: 100,
          silenceDurationMs: 800,
        },
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    },
  };
}

export type GeminiEvent =
  | { type: "setup_complete" }
  | { type: "audio"; data: string }
  | { type: "input_transcript"; text: string }
  | { type: "output_transcript"; text: string }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export function parseGeminiMessage(msg: Record<string, unknown>): GeminiEvent | null {
  if ("setupComplete" in msg) return { type: "setup_complete" };

  const sc = msg.serverContent as Record<string, unknown> | undefined;
  if (!sc) return null;

  if (sc.modelTurn) {
    const turn = sc.modelTurn as { parts?: Array<{ inlineData?: { data: string } }> };
    const audio = turn.parts?.find((p) => p.inlineData?.data);
    if (audio?.inlineData) return { type: "audio", data: audio.inlineData.data };
  }

  if (sc.inputTranscription) {
    const t = sc.inputTranscription as { text: string };
    return { type: "input_transcript", text: t.text };
  }

  if (sc.outputTranscription) {
    const t = sc.outputTranscription as { text: string };
    return { type: "output_transcript", text: t.text };
  }

  if (sc.turnComplete) return { type: "turn_complete" };
  if (sc.interrupted) return { type: "interrupted" };

  return null;
}

export interface GeminiLiveClient {
  connect(): Promise<void>;
  sendAudio(base64Pcm: string): void;
  sendText(text: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export function createGeminiLiveClient(apiKey: string, model: string): GeminiLiveClient {
  const emitter = new EventEmitter();
  let ws: WebSocket | null = null;
  let transcript = "";

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS_URL}?key=${apiKey}`;
      ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        ws?.close();
        reject(new Error("Gemini Live connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        ws!.send(JSON.stringify(buildSetupMessage(model)));
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const event = parseGeminiMessage(msg);
          if (!event) return;

          if (event.type === "setup_complete") {
            clearTimeout(timeout);
            resolve();
          }

          if (event.type === "input_transcript") {
            transcript += `User: ${event.text}\n`;
          }
          if (event.type === "output_transcript") {
            transcript += `AI: ${event.text}\n`;
          }

          emitter.emit(event.type, event);
        } catch {
          // malformed message
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        emitter.emit("error", { type: "error", message: err.message });
        reject(err);
      });

      ws.on("close", () => {
        emitter.emit("disconnected");
      });
    });
  }

  function sendAudio(base64Pcm: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Pcm }],
      },
    }));
  }

  function sendText(text: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }

  function close() {
    ws?.close();
    ws = null;
  }

  return {
    connect,
    sendAudio,
    sendText,
    close,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get transcript() { return transcript; },
  } as GeminiLiveClient & { transcript: string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/onboarding/gemini-live.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/gemini-live.ts tests/gateway/onboarding/gemini-live.test.ts
git commit -m "feat(onboarding): add Gemini Live WebSocket client"
```

---

### Task 6: Profile Extraction

**Files:**
- Create: `packages/gateway/src/onboarding/extract-profile.ts`
- Test: `tests/gateway/onboarding/extract-profile.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/gateway/onboarding/extract-profile.test.ts
import { describe, it, expect, vi } from "vitest";
import { extractProfile, mapProfileToSetupPlan } from "../../packages/gateway/src/onboarding/extract-profile.js";

const VALID_PROFILE = {
  name: "Hamed",
  role: "founder",
  interests: ["AI tools"],
  painPoints: ["too many tools"],
  workStyle: "fast-paced",
  apps: [{ name: "Task Board", description: "Kanban board" }],
  skills: [{ name: "summarize", description: "Summarize text" }],
  personality: { vibe: "concise", traits: ["direct"] },
};

describe("extractProfile", () => {
  it("extracts profile from transcript", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PROFILE) }] } }],
      }),
    });

    const result = await extractProfile("User: I'm a founder...\nAI: Tell me more...", "test-key");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Hamed");
    expect(result!.role).toBe("founder");
  });

  it("returns null on API failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await extractProfile("transcript", "test-key");
    expect(result).toBeNull();
  });
});

describe("mapProfileToSetupPlan", () => {
  it("maps extracted profile to SetupPlan shape", () => {
    const plan = mapProfileToSetupPlan(VALID_PROFILE);
    expect(plan.role).toBe("founder");
    expect(plan.apps).toHaveLength(1);
    expect(plan.skills).toHaveLength(1);
    expect(plan.personality.vibe).toBe("concise");
    expect(plan.status).toBe("pending");
    expect(plan.built).toEqual([]);
  });

  it("uses persona fallback when skills empty", () => {
    const noSkills = { ...VALID_PROFILE, skills: [] };
    const plan = mapProfileToSetupPlan(noSkills);
    expect(plan.skills.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/extract-profile.test.ts`

- [ ] **Step 3: Implement profile extraction**

```typescript
// packages/gateway/src/onboarding/extract-profile.ts
import { ExtractedProfileSchema, type ExtractedProfile } from "./types.js";
import { getPersonaSuggestions } from "../../kernel/src/onboarding.js";
import type { SetupPlan } from "../../kernel/src/onboarding.js";

const EXTRACTION_PROMPT = `Extract the following structured information from this conversation transcript between an AI and a new user. Return ONLY valid JSON, no markdown.

Schema:
{
  "name": "user's name or how they'd like to be called",
  "role": "their primary role/profession",
  "interests": ["list of interests mentioned"],
  "painPoints": ["problems or frustrations they mentioned"],
  "workStyle": "how they described their work style",
  "apps": [{"name": "App Name", "description": "what it does"}],
  "skills": [{"name": "skill-name", "description": "what it does"}],
  "personality": {"vibe": "communication style", "traits": ["personality traits"]}
}

For "apps", suggest 3-5 apps that would genuinely help this person based on what they said. For "skills", suggest 2-3 relevant skills. If something wasn't mentioned, make reasonable inferences from context.`;

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

export function mapProfileToSetupPlan(profile: ExtractedProfile): SetupPlan {
  let skills = profile.skills;
  if (skills.length === 0) {
    const fallback = getPersonaSuggestions(profile.role);
    skills = fallback.skills;
  }

  return {
    role: profile.role,
    customDescription: `${profile.name} - ${profile.workStyle}`,
    apps: profile.apps,
    skills,
    personality: profile.personality,
    status: "pending",
    built: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/onboarding/extract-profile.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/onboarding/extract-profile.ts tests/gateway/onboarding/extract-profile.test.ts
git commit -m "feat(onboarding): add profile extraction with Gemini API"
```

---

### Task 7: Auth Middleware Update

**Files:**
- Modify: `packages/gateway/src/auth.ts`
- Modify: `tests/gateway/auth-hardening.test.ts` (if exists)

- [ ] **Step 1: Read auth.ts to find the exact line**

Read `packages/gateway/src/auth.ts` and find the `WS_QUERY_TOKEN_PATHS` array.

- [ ] **Step 2: Add `/ws/onboarding` to the array**

Change:
```typescript
const WS_QUERY_TOKEN_PATHS = ["/ws/voice"];
```
To:
```typescript
const WS_QUERY_TOKEN_PATHS = ["/ws/voice", "/ws/onboarding"];
```

- [ ] **Step 3: Run existing auth tests to verify nothing breaks**

Run: `bun run test tests/gateway/auth`

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/auth.ts
git commit -m "feat(onboarding): add /ws/onboarding to auth token paths"
```

---

### Task 8: Onboarding WebSocket Handler

This is the main orchestration file. It wires together the state machine, Gemini Live client, profile extraction, username validation, and API key handling.

**Files:**
- Create: `packages/gateway/src/onboarding/ws-handler.ts`
- Modify: `packages/gateway/src/server.ts` (register endpoint)
- Test: `tests/gateway/onboarding/ws-handler.test.ts`

- [ ] **Step 1: Write integration test with mocked Gemini**

```typescript
// tests/gateway/onboarding/ws-handler.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOnboardingHandler, type OnboardingDeps } from "../../packages/gateway/src/onboarding/ws-handler.js";

function mockDeps(): OnboardingDeps {
  return {
    homePath: "/tmp/test-home",
    geminiApiKey: "test-key",
    geminiModel: "gemini-3.1-flash-live-preview",
    platformApiUrl: "http://localhost:9000",
    platformSecret: "test-secret",
    voiceService: {
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("audio"), format: "mp3" }),
    },
    checkOnboardingComplete: vi.fn().mockResolvedValue(false),
    writeOnboardingComplete: vi.fn().mockResolvedValue(undefined),
    readOnboardingState: vi.fn().mockResolvedValue(null),
    writeOnboardingState: vi.fn().mockResolvedValue(undefined),
  };
}

describe("onboarding handler", () => {
  it("rejects concurrent connections", () => {
    const deps = mockDeps();
    const handler = createOnboardingHandler(deps);
    expect(handler.isActive).toBe(false);

    handler.activate();
    expect(handler.isActive).toBe(true);

    expect(() => handler.activate()).toThrow("connection_limit");
  });

  it("sends onboarding_already_complete if done", async () => {
    const deps = mockDeps();
    deps.checkOnboardingComplete = vi.fn().mockResolvedValue(true);
    const handler = createOnboardingHandler(deps);
    const send = vi.fn();

    await handler.onOpen(send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "onboarding_already_complete" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/onboarding/ws-handler.test.ts`

- [ ] **Step 3: Implement the handler**

Create `packages/gateway/src/onboarding/ws-handler.ts` -- this is the largest file. It creates the Gemini Live connection, manages the state machine, relays audio, and handles all control messages. Follow the exact WebSocket pattern from `server.ts` terminal endpoint (using `upgradeWebSocket`).

Key structure:
- `createOnboardingHandler(deps)` returns an object with `isActive`, `activate()`, `deactivate()`, `onOpen(send)`, `onMessage(data)`, `onClose()`
- On `start` message: connect to Gemini Live, begin greeting
- On `audio` message: relay to Gemini Live
- On `text_input` message: send text to Gemini REST API (text mode)
- On stage transitions: persist state to `onboarding-state.json`
- On `claim_username`: validate, call platform API, emit result
- On `choose_activation`: branch state machine
- On `set_api_key`: validate format + live check, store
- On `confirm_apps`: write setup plan, trigger provisioning

- [ ] **Step 4: Register in server.ts**

Add the `/ws/onboarding` endpoint to `packages/gateway/src/server.ts` following the terminal WebSocket pattern:

```typescript
// In server.ts, after the /ws/terminal registration
import { createOnboardingHandler } from "./onboarding/ws-handler.js";

const onboardingHandler = createOnboardingHandler({
  homePath,
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.ONBOARDING_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview",
  platformApiUrl: process.env.PLATFORM_INTERNAL_URL ?? "",
  platformSecret: process.env.PLATFORM_SECRET ?? "",
  voiceService,
  // file helpers for state persistence
});

app.get("/ws/onboarding", upgradeWebSocket(() => {
  return {
    async onOpen(_evt, ws) {
      onboardingHandler.activate();
      await onboardingHandler.onOpen((msg) => ws.send(JSON.stringify(msg)));
    },
    onMessage(evt) {
      const data = typeof evt.data === "string" ? evt.data : "";
      onboardingHandler.onMessage(data);
    },
    onClose() {
      onboardingHandler.onClose();
      onboardingHandler.deactivate();
    },
  };
}));
```

- [ ] **Step 5: Run tests**

Run: `bun run test tests/gateway/onboarding/ws-handler.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/onboarding/ws-handler.ts packages/gateway/src/server.ts tests/gateway/onboarding/ws-handler.test.ts
git commit -m "feat(onboarding): add WebSocket handler with Gemini Live integration"
```

---

### Task 9: Browser Audio Worklet

**Files:**
- Create: `shell/public/audio-worklet-processor.js`

This captures mic audio as PCM16 at 16kHz -- exactly what Gemini Live expects. Based on the hackathon code.

- [ ] **Step 1: Create the audio worklet processor**

```javascript
// shell/public/audio-worklet-processor.js
class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const chunk = input[0];
    // Accumulate samples, send every 800 (50ms at 16kHz)
    const combined = new Float32Array(this._buffer.length + chunk.length);
    combined.set(this._buffer);
    combined.set(chunk, this._buffer.length);
    this._buffer = combined;

    while (this._buffer.length >= 800) {
      const samples = this._buffer.slice(0, 800);
      this._buffer = this._buffer.slice(800);

      // Convert Float32 -> PCM16
      const pcm16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Convert to base64
      const bytes = new Uint8Array(pcm16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.port.postMessage(btoa(binary));
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16CaptureProcessor);
```

- [ ] **Step 2: Commit**

```bash
git add shell/public/audio-worklet-processor.js
git commit -m "feat(onboarding): add PCM16 audio worklet for mic capture"
```

---

### Task 10: Shell Onboarding Hook

**Files:**
- Create: `shell/src/hooks/useOnboarding.ts`

- [ ] **Step 1: Implement the hook**

This hook manages the WebSocket connection to `/ws/onboarding`, audio capture via AudioWorklet (PCM16 at 16kHz), audio playback (PCM16 at 24kHz), and exposes onboarding state to React components.

Key patterns to follow from `useVoice.ts`:
- `getGatewayWs()` for WS URL construction
- `WebSocket` with JSON message parsing
- `AudioContext` for playback
- Refs for WS, AudioContext, MediaStream

The hook exports: `{ stage, audioSource, transcript, apps, isTextMode, errors, startOnboarding, sendUsername, sendActivationChoice, sendApiKey, confirmApps }`

Audio capture: `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })` -> `AudioContext({ sampleRate: 16000 })` -> `AudioWorkletNode("pcm16-capture")` -> base64 chunks sent via WS.

Audio playback (for Gemini Live responses): receive base64 PCM16 at 24kHz -> decode to Float32 -> `AudioBuffer` at 24kHz -> `AudioBufferSourceNode.start()`.

Audio playback (for TTS after interview): receive base64 MP3 -> `decodeAudioData` -> play.

- [ ] **Step 2: Commit**

```bash
git add shell/src/hooks/useOnboarding.ts
git commit -m "feat(onboarding): add useOnboarding hook with audio capture/playback"
```

---

### Task 11: Shell Onboarding Components

**Files:**
- Create: `shell/src/components/OnboardingScreen.tsx`
- Create: `shell/src/components/onboarding/VoiceOrb.tsx`
- Create: `shell/src/components/onboarding/AppSuggestionCards.tsx`
- Create: `shell/src/components/onboarding/UsernameInput.tsx`
- Create: `shell/src/components/onboarding/ActivationChoice.tsx`
- Create: `shell/src/components/onboarding/ApiKeyInput.tsx`

- [ ] **Step 1: Create VoiceOrb component**

Animated CSS orb that pulses with audio. States: `idle`, `listening`, `speaking`, `thinking`. Uses CSS keyframe animations with `scale` and `box-shadow` transitions. Themed with Matrix OS CSS variables.

- [ ] **Step 2: Create sub-components**

Each is a focused component:
- `AppSuggestionCards` -- grid of toggle-able cards, confirm button
- `UsernameInput` -- text input, debounced availability check via WS, `@{username}:matrix-os.com` preview
- `ActivationChoice` -- three cards (API key, Claude Code, Credits), click to select
- `ApiKeyInput` -- password-masked input, paste-friendly, validation feedback

- [ ] **Step 3: Create OnboardingScreen**

Fullscreen component that renders the right sub-component based on `stage` from `useOnboarding`. Layout: centered voice orb, transcript below, stage-specific content slides in/out.

- [ ] **Step 4: Commit**

```bash
git add shell/src/components/OnboardingScreen.tsx shell/src/components/onboarding/
git commit -m "feat(onboarding): add shell onboarding UI components"
```

---

### Task 12: First-Run Detection in Desktop

**Files:**
- Modify: `shell/src/components/Desktop.tsx`

- [ ] **Step 1: Read Desktop.tsx to understand current structure**

Read `shell/src/components/Desktop.tsx` to find where to add the first-run check.

- [ ] **Step 2: Add first-run detection**

On initial mount (using a ref to prevent re-checking on strict mode double-mount):
1. `GET /api/files/stat?path=system/onboarding-complete.json`
2. If 404: set `showOnboarding = true`, render `<OnboardingScreen />`
3. If 200: render normal desktop
4. Retry 3x with 1s delay if gateway unreachable

When onboarding completes (via callback from OnboardingScreen): set `showOnboarding = false`, render desktop.

- [ ] **Step 3: Run shell build to verify no errors**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run --filter shell build`

- [ ] **Step 4: Commit**

```bash
git add shell/src/components/Desktop.tsx
git commit -m "feat(onboarding): add first-run detection to Desktop"
```

---

### Task 13: Platform Session-Based Routing

Replace subdomain routing with session-based routing for `app.matrix-os.com`.

**Files:**
- Modify: `packages/platform/src/main.ts`
- Modify: `distro/cloudflared.yml`
- Modify: `www/src/app/dashboard/actions.ts`

- [ ] **Step 1: Read platform main.ts subdomain router (lines 54-119)**

Understand the current routing logic to know what to replace.

- [ ] **Step 2: Add session-based routing middleware**

Replace the subdomain matching logic. Instead of extracting handle from hostname, extract `clerkUserId` from Clerk session cookie and look up container by `clerkUserId`:

```typescript
// Replace subdomain regex matching with:
const host = c.req.header('host') ?? '';
const isAppDomain = host.startsWith('app.matrix-os.com') || host.startsWith('app.localhost');

if (!isAppDomain) return next();

// Extract Clerk session from cookie
const clerkUserId = await getClerkUserIdFromCookie(c);
if (!clerkUserId) {
  return c.redirect('https://matrix-os.com/signup');
}

const record = getContainerByClerkId(db, clerkUserId);
if (!record) {
  return c.redirect('https://matrix-os.com/dashboard');
}
// ... rest of routing (auto-wake, path-based port selection) stays the same
// but uses record.handle to build container name: matrixos-{record.handle}
```

- [ ] **Step 3: Update cloudflared.yml**

Add `app.matrix-os.com` route:
```yaml
ingress:
  - hostname: grafana.matrix-os.com
    service: http://grafana:3000
  - hostname: api.matrix-os.com
    service: http://platform:9000
  - hostname: app.matrix-os.com
    service: http://platform:9000
  - service: http_status:404
```

- [ ] **Step 4: Update dashboard redirect**

Change `www/src/app/dashboard/actions.ts` to redirect to `app.matrix-os.com` instead of `{handle}.matrix-os.com`.

- [ ] **Step 5: Configure Clerk cookie domain**

Set Clerk to issue cookies on `.matrix-os.com` so they're shared between `matrix-os.com` (www) and `app.matrix-os.com` (shell).

- [ ] **Step 6: Commit**

```bash
git add packages/platform/src/main.ts distro/cloudflared.yml www/src/app/dashboard/actions.ts
git commit -m "feat(platform): session-based routing on app.matrix-os.com"
```

---

### Task 15: Kernel BYOK Support

**Files:**
- Modify: `packages/gateway/src/dispatcher.ts`

- [ ] **Step 1: Read dispatcher.ts to find where env is set**

- [ ] **Step 2: Modify dispatcher to read BYOK key per dispatch**

Before calling `spawnFn(message, config)`, read `~/system/config.json` and check for `kernel.anthropicApiKey`. If present, temporarily set `process.env.ANTHROPIC_API_KEY` for the subprocess:

```typescript
// Inside the dispatch function, before spawning kernel:
const configPath = join(homePath, "system", "config.json");
let byokKey: string | undefined;
try {
  const raw = await readFile(configPath, "utf-8");
  const cfg = JSON.parse(raw);
  byokKey = cfg?.kernel?.anthropicApiKey;
} catch {
  // no config or invalid
}

const prevKey = process.env.ANTHROPIC_API_KEY;
if (byokKey) process.env.ANTHROPIC_API_KEY = byokKey;
try {
  for await (const event of spawnFn(message, config)) {
    entry.onEvent(event);
  }
} finally {
  if (byokKey) process.env.ANTHROPIC_API_KEY = prevKey ?? "";
}
```

- [ ] **Step 3: Run existing kernel tests to verify nothing breaks**

Run: `bun run test tests/kernel`

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/dispatcher.ts
git commit -m "feat(kernel): add BYOK API key support via config.json"
```

---

### Task 16: Migrate writeSetupPlan to Async

**Files:**
- Modify: `packages/kernel/src/onboarding.ts`

- [ ] **Step 1: Read onboarding.ts**

- [ ] **Step 2: Change `writeSetupPlan` from sync to async**

```typescript
// Change from:
export function writeSetupPlan(homePath: string, plan: SetupPlan): void {
  const filePath = join(homePath, "system", PLAN_FILE);
  writeFileSync(filePath, JSON.stringify(plan, null, 2));
}
// To:
export async function writeSetupPlan(homePath: string, plan: SetupPlan): Promise<void> {
  const filePath = join(homePath, "system", PLAN_FILE);
  await writeFile(filePath, JSON.stringify(plan, null, 2));
}
```

Add `import { writeFile } from "node:fs/promises"` at the top. Update all callers (check provisioner.ts and server.ts).

- [ ] **Step 3: Run existing onboarding tests**

Run: `bun run test tests/kernel/onboarding`

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/onboarding.ts
git commit -m "refactor(kernel): migrate writeSetupPlan to async fs/promises"
```

---

### Task 17: CLAUDE.md Enhancement

**Files:**
- Modify: `home/CLAUDE.md`

- [ ] **Step 1: Add skills/knowledge references to home/CLAUDE.md**

Append to the end of the file:

```markdown
## Skills & Knowledge

Skills are in `~/agents/skills/` -- read them when you need specialized capabilities like building apps, debugging, web search, or image generation.

Knowledge files are in `~/agents/knowledge/` -- read them for domain context about app generation, desktop customization, the Matrix design system, and more.

To see available skills: `ls ~/agents/skills/`
To see available knowledge: `ls ~/agents/knowledge/`
```

- [ ] **Step 2: Commit**

```bash
git add home/CLAUDE.md
git commit -m "docs: add skills/knowledge directory references to CLAUDE.md"
```

---

### Task 18: Integration Wiring

Connect the onboarding WS handler to the existing provisioner pipeline. Wire up:

- [ ] **Step 1: Provisioner event relay**

In `ws-handler.ts`, after writing `setup-plan.json`, subscribe to provisioner events and relay them through the onboarding WS as `{ type: "stage", stage: "provisioning", progress: { built, total } }`.

- [ ] **Step 2: Onboarding completion**

After provisioning completes:
- Write `~/system/onboarding-complete.json` with `{ flag: 'wx' }` (`fs/promises.open(path, 'wx')`)
- Delete `~/system/onboarding-state.json`
- Emit `{ type: "stage", stage: "done" }`

- [ ] **Step 3: Path B completion**

If activation path is `claude_code`, skip provisioning:
- Write `onboarding-complete.json` with `{ activationPath: "claude_code" }`
- Emit `{ type: "stage", stage: "done" }`
- Desktop.tsx checks `activationPath` and auto-opens Terminal in Claude Mode

- [ ] **Step 5: Run full test suite**

Run: `bun run test`

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/onboarding/ws-handler.ts packages/gateway/src/server.ts
git commit -m "feat(onboarding): wire provisioning pipeline and completion flow"
```

---

### Task 19: End-to-End Smoke Test

- [ ] **Step 1: Start dev environment**

Run: `bun run docker` (or `bun run dev` for local)

- [ ] **Step 2: Test the onboarding flow manually**

1. Clear `~/system/onboarding-complete.json` from the container
2. Reload shell -- should see OnboardingScreen
3. Grant mic permission -- Gemini Live should start talking
4. Have a brief conversation
5. See app suggestions
6. Claim a username
7. Choose activation path (API key or Claude Code)
8. If API key: paste a valid key, see provisioning
9. If Claude Code: desktop loads, Terminal opens
10. Verify `onboarding-complete.json` was written

- [ ] **Step 3: Test text-mode fallback**

1. Deny mic permission on reload
2. Should fall back to text input mode
3. Same flow, typing instead of speaking

- [ ] **Step 4: Test resume**

1. Start onboarding, get past interview
2. Close browser tab
3. Reopen -- should resume from last completed stage

- [ ] **Step 5: Commit any fixes**

```bash
git add -u
git commit -m "fix(onboarding): address issues found in smoke test"
```
