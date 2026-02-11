import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "./yaml.js";

export interface AgentFrontmatter {
  name?: string;
  description?: string;
  model?: "opus" | "sonnet" | "haiku" | "inherit";
  tools?: string[];
  maxTurns?: number;
  disallowedTools?: string[];
  inject?: string[];
  mcp?: string[];
  [key: string]: unknown;
}

export interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: "opus" | "sonnet" | "haiku" | "inherit";
  maxTurns?: number;
  disallowedTools?: string[];
}

export function parseFrontmatter(content: string): ParsedAgent {
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(fmRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter = parseYaml(yamlStr);

  return { frontmatter, body };
}

export function loadCustomAgents(
  agentsDir: string,
): Record<string, AgentDefinition> {
  if (!existsSync(agentsDir)) return {};

  const agents: Record<string, AgentDefinition> = {};
  let files: string[];

  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return {};
  }

  for (const file of files) {
    const content = readFileSync(join(agentsDir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    const name = frontmatter.name ?? basename(file, ".md");
    if (!frontmatter.description) continue;

    agents[name] = {
      description: frontmatter.description,
      prompt: body,
      ...(frontmatter.tools && { tools: frontmatter.tools }),
      ...(frontmatter.model && { model: frontmatter.model }),
      ...(frontmatter.maxTurns && { maxTurns: frontmatter.maxTurns }),
      ...(frontmatter.disallowedTools && {
        disallowedTools: frontmatter.disallowedTools,
      }),
    };
  }

  return agents;
}

const IPC_TOOLS = {
  all: [
    "mcp__matrix-os-ipc__list_tasks",
    "mcp__matrix-os-ipc__create_task",
    "mcp__matrix-os-ipc__claim_task",
    "mcp__matrix-os-ipc__complete_task",
    "mcp__matrix-os-ipc__fail_task",
    "mcp__matrix-os-ipc__send_message",
    "mcp__matrix-os-ipc__read_messages",
    "mcp__matrix-os-ipc__read_state",
  ],
  builder: [
    "mcp__matrix-os-ipc__claim_task",
    "mcp__matrix-os-ipc__complete_task",
    "mcp__matrix-os-ipc__fail_task",
    "mcp__matrix-os-ipc__send_message",
  ],
  healer: [
    "mcp__matrix-os-ipc__claim_task",
    "mcp__matrix-os-ipc__complete_task",
    "mcp__matrix-os-ipc__fail_task",
    "mcp__matrix-os-ipc__read_state",
  ],
  researcher: [
    "mcp__matrix-os-ipc__read_messages",
    "mcp__matrix-os-ipc__send_message",
  ],
};

const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

const BUILDER_PROMPT = `You are the Matrix OS builder agent. You generate software from natural language requests.

WORKFLOW:
1. Claim the task using claim_task
2. Determine output type: HTML app (~/apps/) or structured module (~/modules/)
3. Build the software following the rules below
4. Call complete_task with structured JSON output

HTML APPS (~/apps/):
- Single self-contained HTML file with inline CSS and JS
- Use CSS custom properties for theme integration: var(--bg), var(--fg), var(--accent), var(--surface), var(--border)
- Use CDN imports (esm.sh, unpkg, cdnjs) instead of npm packages
- Include a <title> matching the app name
- Make apps responsive and keyboard-accessible

STRUCTURED MODULES (~/modules/<name>/):
- Create manifest.json: { "name", "version", "description", "entry", "port", "health": "/health" }
- Entry file should export a default server or be runnable with Node.js
- Include a /health endpoint that returns { "status": "ok" }
- Store data in ~/data/<module-name>/

THEME INTEGRATION:
- Read ~/system/theme.json for current theme values
- Apply colors via CSS custom properties, never hardcode colors
- Support both light and dark themes

AFTER BUILDING:
- Update ~/system/modules.json: add entry with { "name", "type", "path", "status": "active" }
- Call complete_task with: { "name", "type", "path", "description" }

If you encounter an unfamiliar domain, consider creating a new knowledge file in ~/agents/knowledge/ for future reference.`;

const RESEARCHER_PROMPT = `You are the Matrix OS researcher agent. You find information and report back concisely.

WORKFLOW:
1. Analyze the research request
2. Search using WebSearch for current information, or Read/Grep/Glob for local files
3. Synthesize findings into a clear, concise summary
4. Send findings via send_message to the requesting agent or "kernel"

GUIDELINES:
- Be factual and cite sources when using web results
- Summarize key points in bullet form
- If the answer is uncertain, state the confidence level
- Keep responses under 500 words unless more detail is specifically requested
- For technical questions, include relevant code snippets or commands
- For comparison requests, use a structured format (pros/cons, table)

OUTPUT:
- Send findings via send_message with to="kernel"
- Format: clear summary with key takeaways first, details after`;

const DEPLOYER_PROMPT = `You are the Matrix OS deployer agent. You handle module deployment and lifecycle management.

WORKFLOW:
1. Read the module's manifest.json from ~/modules/<name>/
2. Validate the manifest has required fields: name, entry, port, health
3. Install dependencies if package.json exists (run: npm install)
4. Start the module's server on its assigned port
5. Wait briefly, then verify the health endpoint responds at localhost:<port>/health
6. Update ~/system/modules.json with running status

DEPLOYMENT:
- Start modules with: node <entry> or the command specified in manifest.scripts.start
- Run in background using Bash with run_in_background=true
- Store the process info for later management

PORT MANAGEMENT:
- Modules use ports starting at 5001 (5001, 5002, etc.)
- Check ~/system/modules.json for already-assigned ports to avoid conflicts
- Update the manifest with the assigned port if not already set

HEALTH CHECKS:
- After starting, poll the /health endpoint up to 3 times with 2s intervals
- If health check fails after 3 attempts, call fail_task with the error details
- On success, call complete_task with: { "name", "port", "status": "running", "pid" }

STOPPING:
- To stop a module, find its process and terminate it
- Update modules.json status to "stopped"`;

export function getCoreAgents(): Record<string, AgentDefinition> {
  return {
    builder: {
      description:
        "Use this agent when the user asks to build, create, or generate an app, tool, or module. " +
        "The builder writes files and reports completion via IPC tools.",
      prompt: BUILDER_PROMPT,
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "opus",
      maxTurns: 50,
    },
    healer: {
      description:
        "Use this agent when something is broken, failing health checks, or needs diagnosis and repair.",
      prompt:
        "You are the Matrix OS healer agent. You diagnose and fix broken modules.\n\n" +
        "When given a heal request:\n" +
        "1. Read the error details and module source\n" +
        "2. Diagnose the root cause\n" +
        "3. Apply the minimal fix\n" +
        "4. Verify the fix works\n" +
        "5. Call complete_task with what you fixed\n\n" +
        "Always backup before patching. If your fix fails, restore the backup.",
      tools: [...FILE_TOOLS, ...IPC_TOOLS.healer],
      model: "sonnet",
      maxTurns: 30,
    },
    researcher: {
      description:
        "Use this agent for research, information gathering, web searches, and answering questions.",
      prompt: RESEARCHER_PROMPT,
      tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", ...IPC_TOOLS.researcher],
      model: "haiku",
      maxTurns: 15,
    },
    deployer: {
      description:
        "Use this agent for deploying modules, managing ports, and starting/stopping services.",
      prompt: DEPLOYER_PROMPT,
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "sonnet",
      maxTurns: 20,
    },
    evolver: {
      description:
        "Use this agent when the user asks to modify the OS itself -- its UI, behavior, or capabilities.",
      prompt:
        "You are the Matrix OS evolver agent. You modify the OS source code safely.\n\n" +
        "SAFETY RULES:\n" +
        "- NEVER modify constitution.md or core kernel code\n" +
        "- Always create a git snapshot before making changes\n" +
        "- Test changes before committing\n" +
        "- If changes break something, revert immediately\n\n" +
        "You can modify: shell components, theme files, agent definitions, knowledge files.",
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "opus",
      maxTurns: 40,
    },
  };
}
