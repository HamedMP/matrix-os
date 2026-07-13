import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, resolveKernelConfigFileAsync } from "@matrix-os/kernel";
import {
  AgentProfileSummarySchema,
  type AgentProfileSummary,
} from "@matrix-os/contracts";
import { resolveKernelCredentialMode } from "./kernel-credentials.js";
import { resolveKernelModelOption } from "./kernel-settings.js";

const SOUL_SUMMARY_FILE_LIMIT = 16 * 1024;

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function sanitizeProfileText(value: string, maxChars: number): string {
  return value
    .replace(/\b(?:sk|ghp|glpat|github_pat)[-_][A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]*password\s*[=:](?:[ \t]*(?:"[^"]*"|'[^']*'|[^\s,;]+))?/gi, "[redacted]")
    .replace(/\b(?:(?:postgres(?:ql)?|mysql):\/\/|sqlite:)[^\s)>\]]+/gi, "[redacted]")
    .replace(/\/(?:home|tmp|var|opt|etc|root|Users)\/[^\s)>\]]+/g, "[redacted]")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

async function readBoundedSoul(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
  } catch (err) {
    if (isNotFoundError(err)) return "";
    throw err;
  }
  try {
    const buffer = Buffer.alloc(SOUL_SUMMARY_FILE_LIMIT + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, Math.min(bytesRead, SOUL_SUMMARY_FILE_LIMIT)).toString("utf-8");
  } finally {
    await file.close();
  }
}

function summarizeSoul(content: string): {
  identity: { name?: string; tagline?: string };
  soulPreview: string;
} {
  const { frontmatter, body } = parseFrontmatter(content);
  const heading = body.match(/^\s*#{1,6}\s+(.+)$/m)?.[1];
  const nameSource = typeof frontmatter.name === "string" ? frontmatter.name : heading;
  const firstParagraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.length > 0 && !/^#{1,6}\s/.test(paragraph));
  const taglineSource = typeof frontmatter.tagline === "string"
    ? frontmatter.tagline
    : firstParagraph;

  const name = nameSource ? sanitizeProfileText(nameSource, 80) : "";
  const tagline = taglineSource ? sanitizeProfileText(taglineSource, 180) : "";
  const soulPreview = firstParagraph
    ? sanitizeProfileText(firstParagraph, 280)
    : "No soul profile configured.";

  return {
    identity: {
      ...(name ? { name } : {}),
      ...(tagline ? { tagline } : {}),
    },
    soulPreview: soulPreview || "No soul profile configured.",
  };
}

export async function buildAgentProfileSummary(homePath: string): Promise<AgentProfileSummary> {
  const soul = summarizeSoul(await readBoundedSoul(join(homePath, "system/soul.md")));
  const kernel = await resolveKernelConfigFileAsync(homePath);
  const model = resolveKernelModelOption(kernel.model);
  const credentialMode = await resolveKernelCredentialMode(homePath);
  return AgentProfileSummarySchema.parse({
    identity: soul.identity,
    kernel: {
      model: model.id,
      modelLabel: model.label,
      effort: kernel.effort,
    },
    credentials: { mode: credentialMode },
    soulPreview: soul.soulPreview,
  });
}
