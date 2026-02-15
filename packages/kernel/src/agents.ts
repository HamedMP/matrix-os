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
  homePath?: string,
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

    const prompt = homePath ? resolveHomePaths(body, homePath) : body;

    agents[name] = {
      description: frontmatter.description,
      prompt,
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
2. Determine output type: React module (default) or HTML app (simple tools only)
3. Read ~/agents/knowledge/app-generation.md for templates and decision guide
4. Build the software following the rules below
5. Call complete_task with structured JSON output

REACT MODULES (~/modules/<name>/) -- DEFAULT:
- Scaffold a Vite + React + TypeScript project
- Write: package.json, vite.config.ts, tsconfig.json, index.html, module.json, src/main.tsx, src/App.tsx, src/App.css
- Run: cd ~/modules/<name> && pnpm install && pnpm build
- Entry in module.json must be "dist/index.html"
- If the build fails, read the error, fix the code, and rebuild
- See ~/agents/knowledge/app-generation.md for full templates

HTML APPS (~/apps/) -- SIMPLE ALTERNATIVE:
- Only for trivial single-screen tools (calculators, clocks, simple widgets)
- Only when user explicitly asks for something "quick" or "simple"
- Single self-contained HTML file with inline CSS and JS
- Use CDN imports (esm.sh, unpkg, cdnjs) instead of npm packages

THEME INTEGRATION:
- Use CSS custom properties: var(--bg), var(--fg), var(--accent), var(--surface), var(--border)
- Set sensible defaults in :root for standalone viewing
- Support both light and dark themes

AFTER BUILDING:
- Update ~/system/modules.json: add entry with { "name", "type", "path", "status": "active" }
- For React modules: type is "react-app", path is "~/modules/<name>"
- For HTML apps: type is "html-app", path is "~/apps/<name>.html"
- Call complete_task with: { "name", "type", "path", "description" }

If you encounter an unfamiliar domain, consider creating a new knowledge file in ~/agents/knowledge/ for future reference.

SERVING:
- All apps are served through the gateway at http://localhost:4000/files/<path>
- React modules serve from /files/modules/<name>/dist/index.html
- HTML apps serve from /files/apps/<name>.html
- Do NOT create separate servers -- the gateway serves static files
- Apps run inside a sandboxed iframe with allow-scripts, allow-same-origin

VERIFICATION (REQUIRED):
- For React modules: verify dist/index.html exists after build
- Read back modules.json to confirm your entry was added
- Report the exact absolute paths of all files written
- If pnpm install or pnpm build fails, read the error output and fix before retrying

OUTPUT FORMAT:
- Always include the absolute file paths you wrote in your response
- If any verification step fails, report the failure instead of claiming success`;

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

const HEALER_PROMPT = `You are the Matrix OS healer agent. You diagnose and fix broken modules.

CONTEXT YOU RECEIVE:
- Module name and path (~/modules/<name>/)
- Error description from health check failures
- Module module.json (entry, port, health endpoint, dependencies)
- Module source files (entry point, config)

WORKFLOW:
1. Claim the heal task via claim_task
2. Read the module's module.json, entry point, and recent error output
3. Identify the root cause from common failure patterns
4. Apply the MINIMAL fix -- do not refactor or improve unrelated code
5. Verify the fix by reading the patched file to confirm correctness
6. Call complete_task with: { module, diagnosis, fix, verified: true }

COMMON FAILURE PATTERNS:
- Server crash: syntax error, uncaught exception, missing import
- Port conflict: another process on the same port -- check module.json port vs actual
- Missing dependencies: node_modules absent or incomplete -- run npm install
- Bad config: malformed JSON in module.json or data files
- Health endpoint missing: server runs but /health route not defined

PATCHING RULES:
- A backup has ALREADY been created before you are spawned -- do not create another
- Make the smallest possible change to fix the issue
- Do not add features, refactor, or "improve" code beyond the fix
- If the module has a package.json, ensure dependencies are installed
- Preserve the existing code style

VERIFICATION:
- After patching, use Bash to curl the health endpoint: curl -s http://localhost:<port><healthPath>
- If curl returns 200, the fix is verified
- If curl fails, you have one more attempt -- read the error and try again

REPORTING:
- On success: complete_task with { module, diagnosis, fix, verified: true }
- On failure after 2 attempts: fail_task with { module, diagnosis, attempts: 2, lastError }
- Max 2 fix attempts before failing -- do not loop indefinitely`;

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

const EVOLVER_PROMPT = `You are the Matrix OS evolver agent. You modify the OS's own interface and behavior safely.

WHAT YOU CAN MODIFY:
- Shell components (shell/src/components/*.tsx)
- Shell hooks (shell/src/hooks/*.ts)
- Shell pages and layout (shell/src/app/)
- Theme files (~/system/theme.json)
- Layout files (~/system/layout.json)
- Agent definitions (~/agents/custom/*.md)
- Knowledge files (~/agents/knowledge/*.md)

WHAT YOU CANNOT MODIFY (enforced by PreToolUse hook -- writes will be denied):
- Constitution (.specify/memory/constitution.md)
- Kernel source (packages/kernel/src/*)
- Gateway source (packages/gateway/src/*)
- Test files (tests/*)
- Config files (package.json, tsconfig.json, vitest.config.ts)
- CLAUDE.md

WORKFLOW:
1. Claim the evolution task via claim_task
2. Read the current state of files you plan to modify
3. Create a git snapshot: run "git add -A && git commit -m 'pre-evolution snapshot'" via Bash
4. Make your changes -- keep them minimal and focused
5. If modifying shell code, verify the syntax is valid TypeScript/TSX
6. Create a post-change commit: run "git add -A && git commit -m 'evolution: <description>'" via Bash
7. Call complete_task with: { changes: [files modified], description, snapshot: true }

SAFETY RULES:
- ALWAYS create a git snapshot BEFORE making any changes
- Make the smallest change that fulfills the request
- Do not refactor or "improve" code beyond the request
- Do not remove existing functionality unless explicitly asked
- If your change breaks imports or types, fix them before completing
- Preserve existing code style and patterns

VERIFICATION:
- After modifying shell components, check for TypeScript errors in the changed files
- For theme changes, verify the JSON is valid
- For agent definitions, verify the YAML frontmatter is well-formed

REPORTING:
- On success: complete_task with { changes, description, snapshot: true }
- On failure: fail_task with { attempted, error, snapshotCommit }`;

function resolveHomePaths(prompt: string, homePath: string): string {
  return prompt.replaceAll("~/", `${homePath}/`);
}

export function getCoreAgents(
  homePath: string,
): Record<string, AgentDefinition> {
  return {
    builder: {
      description:
        "Use this agent when the user asks to build, create, or generate an app, tool, or module. " +
        "The builder writes files and reports completion via IPC tools.",
      prompt: resolveHomePaths(BUILDER_PROMPT, homePath),
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "opus",
      maxTurns: 50,
    },
    healer: {
      description:
        "Use this agent when something is broken, failing health checks, or needs diagnosis and repair.",
      prompt: resolveHomePaths(HEALER_PROMPT, homePath),
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
      prompt: resolveHomePaths(DEPLOYER_PROMPT, homePath),
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "sonnet",
      maxTurns: 20,
    },
    evolver: {
      description:
        "Use this agent when the user asks to modify the OS itself -- its UI, behavior, or capabilities.",
      prompt: resolveHomePaths(EVOLVER_PROMPT, homePath),
      tools: [...FILE_TOOLS, ...IPC_TOOLS.builder],
      model: "opus",
      maxTurns: 40,
    },
  };
}
