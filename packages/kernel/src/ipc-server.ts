import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MatrixDB } from "./db.js";
import {
  listTasks,
  claimTask,
  completeTask,
  failTask,
  sendMessage,
  readMessages,
  readState,
  createTask,
} from "./ipc.js";
import { loadSkillBody } from "./skills.js";
import { createMemoryStore } from "./memory.js";
import { createImageClient } from "./image-gen.js";
import { createUsageTracker } from "./usage.js";
import { getPersonaSuggestions, writeSetupPlan, SetupPlanSchema } from "./onboarding.js";
import { saveIdentity, deriveAiHandle } from "./identity.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(execFile);

export function createIpcServer(db: MatrixDB, homePath?: string) {
  return createSdkMcpServer({
    name: "matrix-os-ipc",
    tools: [
      tool(
        "list_tasks",
        "List tasks, optionally filtered by status or assignee",
        {
          status: z
            .enum(["pending", "in_progress", "completed", "failed"])
            .optional(),
          assigned_to: z.string().optional(),
        },
        async ({ status, assigned_to }) => {
          const result = listTasks(db, {
            status,
            assignedTo: assigned_to,
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),

      tool(
        "create_task",
        "Create a new task for an agent to work on",
        {
          type: z.string(),
          input: z.string(),
          priority: z.number().optional(),
        },
        async ({ type, input, priority }) => {
          const id = createTask(db, {
            type,
            input: JSON.parse(input),
            priority,
          });
          return {
            content: [
              { type: "text" as const, text: `Created task: ${id}` },
            ],
          };
        },
      ),

      tool(
        "claim_task",
        "Claim an unassigned pending task for this agent",
        { task_id: z.string() },
        async ({ task_id }) => {
          const result = claimTask(db, task_id, "agent");
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Claimed task ${task_id}`
                  : `Failed to claim task ${task_id} (already claimed or not found)`,
              },
            ],
          };
        },
      ),

      tool(
        "complete_task",
        "Mark a task as completed with output",
        { task_id: z.string(), output: z.string() },
        async ({ task_id, output }) => {
          const result = completeTask(db, task_id, JSON.parse(output));
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Completed task ${task_id}`
                  : `Failed to complete task ${task_id}`,
              },
            ],
          };
        },
      ),

      tool(
        "fail_task",
        "Mark a task as failed with error details",
        { task_id: z.string(), error: z.string() },
        async ({ task_id, error }) => {
          const result = failTask(db, task_id, error);
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Failed task ${task_id}`
                  : `Task ${task_id} not found`,
              },
            ],
          };
        },
      ),

      tool(
        "send_message",
        "Send a message to another agent or the kernel",
        { to: z.string(), content: z.string() },
        async ({ to, content }) => {
          sendMessage(db, { from: "agent", to, content });
          return {
            content: [
              { type: "text" as const, text: `Message sent to ${to}` },
            ],
          };
        },
      ),

      tool(
        "read_messages",
        "Read unread messages for this agent",
        {},
        async () => {
          const msgs = readMessages(db, "agent");
          return {
            content: [
              {
                type: "text" as const,
                text:
                  msgs.length > 0
                    ? JSON.stringify(msgs, null, 2)
                    : "No unread messages",
              },
            ],
          };
        },
      ),

      tool("read_state", "Read the current Matrix OS state summary", {}, async () => {
        const state = readState(db);
        return {
          content: [{ type: "text" as const, text: state }],
        };
      }),

      tool(
        "load_skill",
        "Load the full instructions for a skill by name. Use this when a user request matches a skill's triggers.",
        { skill_name: z.string() },
        async ({ skill_name }) => {
          if (!homePath) {
            return {
              content: [
                { type: "text" as const, text: "Skills not available (no home path configured)" },
              ],
            };
          }
          const body = loadSkillBody(homePath, skill_name);
          return {
            content: [
              {
                type: "text" as const,
                text: body ?? `Skill "${skill_name}" not found`,
              },
            ],
          };
        },
      ),

      tool(
        "get_persona_suggestions",
        "Get recommended apps, skills, and personality for a user role. Use during onboarding to propose a setup.",
        { role: z.string().describe("The user's role (e.g. 'student', 'developer', 'investor', or any custom role)") },
        async ({ role }) => {
          const suggestions = getPersonaSuggestions(role);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(suggestions, null, 2) },
            ],
          };
        },
      ),

      tool(
        "write_setup_plan",
        "Write the onboarding setup plan to ~/system/setup-plan.json. Call this after the user confirms the proposed setup.",
        { plan_json: z.string().describe("JSON string of the setup plan") },
        async ({ plan_json }) => {
          if (!homePath) {
            return {
              content: [
                { type: "text" as const, text: "Cannot write setup plan (no home path configured)" },
              ],
            };
          }
          try {
            const raw = JSON.parse(plan_json);
            const result = SetupPlanSchema.safeParse(raw);
            if (!result.success) {
              return {
                content: [
                  { type: "text" as const, text: `Invalid setup plan: ${result.error.message}` },
                ],
              };
            }
            writeSetupPlan(homePath, result.data);
            return {
              content: [
                { type: "text" as const, text: "Setup plan written to ~/system/setup-plan.json" },
              ],
            };
          } catch (e) {
            return {
              content: [
                { type: "text" as const, text: `Failed to write setup plan: ${e instanceof Error ? e.message : String(e)}` },
              ],
            };
          }
        },
      ),
      tool(
        "set_handle",
        "Set the user's handle (username) for their Matrix OS identity. Creates @handle:matrix-os.com and @handle_ai:matrix-os.com.",
        {
          handle: z.string().describe("The username (lowercase, no spaces, e.g. 'hamed')"),
          display_name: z.string().describe("The user's display name (e.g. 'Hamed')"),
        },
        async ({ handle, display_name }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot set handle (no home path)" }] };
          }
          const cleaned = handle.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          if (!cleaned) {
            return { content: [{ type: "text" as const, text: "Invalid handle. Use lowercase letters, numbers, underscores, or hyphens." }] };
          }
          saveIdentity(homePath, {
            handle: cleaned,
            aiHandle: deriveAiHandle(cleaned),
            displayName: display_name,
            createdAt: new Date().toISOString(),
          });
          return {
            content: [{
              type: "text" as const,
              text: `Handle set! You are now @${cleaned}:matrix-os.com and your AI is @${deriveAiHandle(cleaned)}:matrix-os.com`,
            }],
          };
        },
      ),

      tool(
        "sync_files",
        "Manage git sync for the user's home directory. Commit local changes, push to remote, pull from remote, add/remove remotes, or check status.",
        {
          action: z.enum(["status", "commit", "push", "pull", "add_remote", "remove_remote"]),
          message: z.string().optional().describe("Commit message (for commit action)"),
          remote_name: z.string().optional().describe("Remote name (default: origin)"),
          remote_url: z.string().optional().describe("Remote URL (for add_remote)"),
        },
        async ({ action, message, remote_name, remote_url }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Sync not available (no home path)" }] };
          }
          async function git(...args: string[]): Promise<string> {
            const { stdout } = await execAsync("git", args, { cwd: homePath! });
            return stdout.trim();
          }
          try {
            switch (action) {
              case "status": {
                const porcelain = await git("status", "--porcelain");
                const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => "unknown");
                const remotes = await git("remote", "-v").catch(() => "none");
                return { content: [{ type: "text" as const, text: `Branch: ${branch}\nClean: ${porcelain === ""}\nRemotes:\n${remotes}\n${porcelain ? `Changes:\n${porcelain}` : ""}` }] };
              }
              case "commit": {
                const porcelain = await git("status", "--porcelain");
                if (porcelain === "") {
                  return { content: [{ type: "text" as const, text: "Nothing to commit -- working tree clean" }] };
                }
                await git("add", "-A");
                await git("commit", "-m", message ?? "sync");
                return { content: [{ type: "text" as const, text: `Committed: ${message ?? "sync"}` }] };
              }
              case "push": {
                const remote = remote_name ?? "origin";
                const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
                await git("push", "-u", remote, branch);
                return { content: [{ type: "text" as const, text: `Pushed to ${remote}/${branch}` }] };
              }
              case "pull": {
                const remote = remote_name ?? "origin";
                const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
                await git("pull", remote, branch);
                return { content: [{ type: "text" as const, text: `Pulled from ${remote}/${branch}` }] };
              }
              case "add_remote": {
                if (!remote_name || !remote_url) {
                  return { content: [{ type: "text" as const, text: "add_remote requires remote_name and remote_url" }] };
                }
                await git("remote", "add", remote_name, remote_url);
                return { content: [{ type: "text" as const, text: `Added remote: ${remote_name} -> ${remote_url}` }] };
              }
              case "remove_remote": {
                if (!remote_name) {
                  return { content: [{ type: "text" as const, text: "remove_remote requires remote_name" }] };
                }
                await git("remote", "remove", remote_name);
                return { content: [{ type: "text" as const, text: `Removed remote: ${remote_name}` }] };
              }
            }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Sync error: ${e instanceof Error ? e.message : String(e)}` }] };
          }
        },
      ),

      tool(
        "manage_cron",
        "Manage scheduled cron jobs. Use 'add' to create reminders/recurring tasks, 'remove' to delete, 'list' to view all.",
        {
          action: z.enum(["add", "remove", "list"]),
          name: z.string().optional().describe("Job name (required for add)"),
          message: z.string().optional().describe("Message to deliver when job fires (required for add)"),
          schedule: z.string().optional().describe("JSON schedule object, e.g. {\"type\":\"interval\",\"intervalMs\":3600000} or {\"type\":\"cron\",\"cron\":\"0 9 * * *\"} or {\"type\":\"once\",\"at\":\"2026-03-01T09:00:00Z\"}"),
          job_id: z.string().optional().describe("Job ID (required for remove)"),
          channel: z.string().optional().describe("Target channel for delivery (telegram, discord, slack, whatsapp)"),
          chat_id: z.string().optional().describe("Target chat ID for delivery"),
        },
        async ({ action, name, message, schedule, job_id, channel, chat_id }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cron not available (no home path)" }] };
          }
          const cronPath = join(homePath, "system", "cron.json");

          function readJobs(): unknown[] {
            if (!existsSync(cronPath)) return [];
            try { return JSON.parse(readFileSync(cronPath, "utf-8")); } catch { return []; }
          }

          function writeJobs(jobs: unknown[]) {
            writeFileSync(cronPath, JSON.stringify(jobs, null, 2) + "\n");
          }

          switch (action) {
            case "list": {
              const jobs = readJobs();
              return { content: [{ type: "text" as const, text: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : "No cron jobs" }] };
            }
            case "add": {
              if (!name || !message || !schedule) {
                return { content: [{ type: "text" as const, text: "add requires name, message, and schedule" }] };
              }
              let parsed: unknown;
              try { parsed = JSON.parse(schedule); } catch {
                return { content: [{ type: "text" as const, text: "Invalid schedule JSON" }] };
              }
              const job = {
                id: `cron_${randomUUID().slice(0, 8)}`,
                name,
                message,
                schedule: parsed,
                target: channel ? { channel, chatId: chat_id } : undefined,
                createdAt: new Date().toISOString(),
              };
              const jobs = readJobs();
              jobs.push(job);
              writeJobs(jobs);
              return { content: [{ type: "text" as const, text: `Created cron job: ${job.id} (${name})` }] };
            }
            case "remove": {
              if (!job_id) {
                return { content: [{ type: "text" as const, text: "remove requires job_id" }] };
              }
              const jobs = readJobs();
              const filtered = jobs.filter((j: any) => j.id !== job_id);
              if (filtered.length === jobs.length) {
                return { content: [{ type: "text" as const, text: `Job ${job_id} not found` }] };
              }
              writeJobs(filtered);
              return { content: [{ type: "text" as const, text: `Removed cron job: ${job_id}` }] };
            }
          }
        },
      ),

      tool(
        "new_conversation",
        "Create a new conversation session. Returns the session ID. Use this when the user wants to start a fresh chat.",
        {
          channel: z.string().optional().describe("Optional channel prefix (e.g. 'telegram')"),
        },
        async ({ channel }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot create conversation (no home path)" }] };
          }
          const convDir = join(homePath, "system", "conversations");
          mkdirSync(convDir, { recursive: true });
          const uuid = randomUUID();
          const id = channel ? `${channel}:${uuid}` : uuid;
          const now = Date.now();
          const conv = { id, createdAt: now, updatedAt: now, messages: [] };
          writeFileSync(join(convDir, `${id}.json`), JSON.stringify(conv, null, 2));
          return { content: [{ type: "text" as const, text: `Created conversation: ${id}` }] };
        },
      ),

      tool(
        "search_conversations",
        "Search across all conversation sessions for messages matching a query. Use this to find context from previous conversations when the user references something discussed before.",
        {
          query: z.string().describe("Search query (case-insensitive substring match)"),
          limit: z.number().optional().describe("Max results to return (default 10)"),
        },
        async ({ query, limit }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot search conversations (no home path)" }] };
          }
          const convDir = join(homePath, "system", "conversations");
          if (!existsSync(convDir)) {
            return { content: [{ type: "text" as const, text: "No conversations found" }] };
          }

          const maxResults = limit ?? 10;
          const lowerQuery = query.toLowerCase();
          const results: Array<{
            sessionId: string;
            messageIndex: number;
            role: string;
            preview: string;
            timestamp: number;
          }> = [];

          const files = readdirSync(convDir).filter((f: string) => f.endsWith(".json"));
          for (const f of files) {
            try {
              const data = JSON.parse(readFileSync(join(convDir, f), "utf-8"));
              const messages = data.messages ?? [];
              for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (msg.content?.toLowerCase().includes(lowerQuery)) {
                  results.push({
                    sessionId: data.id ?? f.replace(".json", ""),
                    messageIndex: i,
                    role: msg.role,
                    preview: msg.content.length > 100
                      ? msg.content.slice(0, 100) + "..."
                      : msg.content,
                    timestamp: msg.timestamp ?? 0,
                  });
                }
              }
            } catch {
              // skip malformed files
            }
          }

          results.sort((a, b) => b.timestamp - a.timestamp);
          const limited = results.slice(0, maxResults);

          return {
            content: [{
              type: "text" as const,
              text: limited.length > 0
                ? JSON.stringify(limited, null, 2)
                : `No messages matching "${query}" found`,
            }],
          };
        },
      ),

      tool(
        "remember",
        "Store a memory about the user. Use when user says 'remember that...', 'I prefer...', 'my X is Y', or states a fact worth remembering.",
        {
          content: z.string().describe("The fact or preference to remember"),
          category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Memory category (default: fact)"),
        },
        async ({ content, category }) => {
          const store = createMemoryStore(db);
          const id = store.remember(content, { category });
          return {
            content: [{ type: "text" as const, text: `Remembered: "${content}" (${id})` }],
          };
        },
      ),

      tool(
        "recall",
        "Search stored memories. Use when the kernel needs context that might have been stored before.",
        {
          query: z.string().describe("Search query to find relevant memories"),
          limit: z.number().optional().describe("Max results (default: 10)"),
          category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Filter by category"),
        },
        async ({ query, limit, category }) => {
          const store = createMemoryStore(db);
          const results = store.recall(query, { limit, category });
          return {
            content: [{
              type: "text" as const,
              text: results.length > 0
                ? JSON.stringify(results, null, 2)
                : "No matching memories found",
            }],
          };
        },
      ),

      tool(
        "forget",
        "Remove a specific memory. Use when user says 'forget that', 'that's no longer true'.",
        {
          id: z.string().describe("The memory ID to remove"),
        },
        async ({ id }) => {
          const store = createMemoryStore(db);
          store.forget(id);
          return {
            content: [{ type: "text" as const, text: `Forgot memory: ${id}` }],
          };
        },
      ),

      tool(
        "list_memories",
        "List all stored memories. Use when user asks 'what do you remember about me?'",
        {
          category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Filter by category"),
        },
        async ({ category }) => {
          const store = createMemoryStore(db);
          const results = store.listAll({ category });
          return {
            content: [{
              type: "text" as const,
              text: results.length > 0
                ? JSON.stringify(results, null, 2)
                : "No memories stored yet",
            }],
          };
        },
      ),

      tool(
        "generate_image",
        "Generate an image from a text description using AI. Saves to ~/data/images/. Returns the local file path.",
        {
          prompt: z.string().describe("Text description of the image to generate"),
          model: z.enum(["fal-ai/flux/schnell", "fal-ai/flux/dev"]).optional().describe("Model to use (default: schnell for speed, dev for quality)"),
          size: z.string().optional().describe("Image dimensions (default: 1024x1024)"),
          save_as: z.string().optional().describe("Custom filename for the saved image"),
        },
        async ({ prompt, model, size, save_as }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot generate image (no home path)" }] };
          }

          const apiKey = process.env.FAL_API_KEY ?? "";
          if (!apiKey) {
            try {
              const configPath = join(homePath, "system", "config.json");
              if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, "utf-8"));
                if (config.media?.fal_api_key) {
                  return generateWithKey(config.media.fal_api_key);
                }
              }
            } catch {}
            return { content: [{ type: "text" as const, text: "Image generation not configured. Set FAL_API_KEY or add media.fal_api_key to config.json." }] };
          }

          return generateWithKey(apiKey);

          async function generateWithKey(key: string) {
            const client = createImageClient(key);
            const tracker = createUsageTracker(homePath!);
            const imageDir = join(homePath!, "data", "images");

            try {
              const result = await client.generateImage(prompt, {
                model,
                size,
                imageDir,
                saveAs: save_as,
              });

              tracker.track("image_gen", result.cost, { model: result.model, prompt });

              return {
                content: [{
                  type: "text" as const,
                  text: `Image generated and saved to ${result.localPath}\nModel: ${result.model}\nCost: $${result.cost.toFixed(4)}\n\nTo display: ~/data/images/${result.localPath.split("/").pop()}`,
                }],
              };
            } catch (e) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Image generation failed: ${e instanceof Error ? e.message : String(e)}`,
                }],
              };
            }
          }
        },
      ),

      tool(
        "speak",
        "Convert text to speech audio using ElevenLabs. Saves audio to ~/data/audio/. Useful for proactive audio messages.",
        {
          text: z.string().describe("Text to convert to speech"),
          voice_id: z.string().optional().describe("Custom ElevenLabs voice ID"),
        },
        async ({ text, voice_id }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot speak (no home path)" }] };
          }

          let voiceConfig: { elevenlabs_key?: string; voice_id?: string; model?: string; enabled?: boolean } = {};
          try {
            const configPath = join(homePath, "system", "config.json");
            if (existsSync(configPath)) {
              const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
              voiceConfig = cfg.voice ?? {};
            }
          } catch {}

          const apiKey = process.env.ELEVENLABS_API_KEY ?? voiceConfig.elevenlabs_key ?? "";
          if (!apiKey) {
            return { content: [{ type: "text" as const, text: "Voice not configured. Set ELEVENLABS_API_KEY or add voice.elevenlabs_key to config.json." }] };
          }

          const vid = voice_id ?? voiceConfig.voice_id ?? "21m00Tcm4TlvDq8ikWAM";
          const model = voiceConfig.model ?? "eleven_turbo_v2_5";

          try {
            const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text,
                model_id: model,
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
              }),
            });

            if (!response.ok) {
              return { content: [{ type: "text" as const, text: `TTS failed: ${response.status} ${response.statusText}` }] };
            }

            const arrayBuffer = await response.arrayBuffer();
            const audioDir = join(homePath, "data", "audio");
            mkdirSync(audioDir, { recursive: true });
            const fileName = `${Date.now()}-tts.mp3`;
            const localPath = join(audioDir, fileName);
            writeFileSync(localPath, Buffer.from(arrayBuffer));

            const cost = text.length * 0.0003;
            const tracker = createUsageTracker(homePath);
            tracker.track("voice_tts", cost, { chars: text.length });

            return {
              content: [{ type: "text" as const, text: `Audio saved to ${localPath}\nCost: $${cost.toFixed(4)}` }],
            };
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: `TTS error: ${e instanceof Error ? e.message : String(e)}` }],
            };
          }
        },
      ),

      tool(
        "transcribe",
        "Convert audio file to text using speech-to-text. Returns transcription.",
        {
          audio_path: z.string().describe("Path to audio file to transcribe"),
        },
        async ({ audio_path }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot transcribe (no home path)" }] };
          }

          let voiceConfig: { elevenlabs_key?: string; stt_provider?: string } = {};
          try {
            const configPath = join(homePath, "system", "config.json");
            if (existsSync(configPath)) {
              const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
              voiceConfig = cfg.voice ?? {};
            }
          } catch {}

          const apiKey = process.env.ELEVENLABS_API_KEY ?? voiceConfig.elevenlabs_key ?? "";
          if (!apiKey) {
            return { content: [{ type: "text" as const, text: "Voice not configured. Set ELEVENLABS_API_KEY or add voice.elevenlabs_key to config.json." }] };
          }

          const absPath = audio_path.startsWith("/") ? audio_path : join(homePath, audio_path.replace(/^~\//, ""));
          if (!existsSync(absPath)) {
            return { content: [{ type: "text" as const, text: `Audio file not found: ${absPath}` }] };
          }

          try {
            const audioBuffer = readFileSync(absPath);
            const formData = new FormData();
            const blob = new Blob([audioBuffer], { type: "audio/webm" });
            formData.append("audio", blob, "recording.webm");
            formData.append("model_id", "scribe_v1");

            const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
              method: "POST",
              headers: { "xi-api-key": apiKey },
              body: formData,
            });

            if (!response.ok) {
              return { content: [{ type: "text" as const, text: `STT failed: ${response.status} ${response.statusText}` }] };
            }

            const data = await response.json() as { text: string };
            const estimatedSeconds = audioBuffer.length / 16000;
            const cost = estimatedSeconds * 0.0017;
            const tracker = createUsageTracker(homePath);
            tracker.track("voice_stt", cost, { audio_path: absPath });

            return {
              content: [{ type: "text" as const, text: `Transcription: ${data.text}\nCost: $${cost.toFixed(4)}` }],
            };
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: `STT error: ${e instanceof Error ? e.message : String(e)}` }],
            };
          }
        },
      ),
    ],
  });
}
