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
