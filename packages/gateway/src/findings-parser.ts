import { readFile } from "node:fs/promises";
import { z } from "zod/v4";

export type FindingSeverity = "high" | "medium" | "low";

export interface ParsedFinding {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  summary: string;
  details?: string;
}

export interface FindingsParseSuccess {
  ok: true;
  parserStatus: "success";
  findings: ParsedFinding[];
  findingsCount: number;
  severityCounts: { high: number; medium: number; low: number };
}

export interface FindingsParseFailure {
  ok: false;
  parserStatus: "failed";
  error: { code: string; message: string };
}

const SeveritySchema = z.enum(["high", "medium", "low"]);
const SafeFindingPathSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\0"));

function failure(code: string, message: string): FindingsParseFailure {
  return { ok: false, parserStatus: "failed", error: { code, message } };
}

function success(findings: ParsedFinding[]): FindingsParseSuccess {
  const severityCounts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    severityCounts[finding.severity] += 1;
  }
  return {
    ok: true,
    parserStatus: "success",
    findings,
    findingsCount: findings.length,
    severityCounts,
  };
}

function findingsSection(markdown: string): string | null {
  const match = /^## Findings\s*$/im.exec(markdown);
  if (!match || typeof match.index !== "number") return null;
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextSection = /^##\s+/im.exec(rest);
  return nextSection && typeof nextSection.index === "number"
    ? rest.slice(0, nextSection.index)
    : rest;
}

function field(block: string, name: string): string | null {
  const expression = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im");
  const match = expression.exec(block);
  return match?.[1]?.trim() ?? null;
}

function details(block: string): string | undefined {
  const match = /^Details:\s*([\s\S]*)$/im.exec(block);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseFindingBlock(block: string): ParsedFinding | FindingsParseFailure {
  const heading = /^###\s+Finding\s+([A-Za-z0-9_-]+)\s*$/im.exec(block);
  const severityValue = field(block, "Severity");
  const fileValue = field(block, "File");
  const lineValue = field(block, "Line");
  const summaryValue = field(block, "Summary");
  if (!heading?.[1] || !severityValue || !fileValue || !lineValue || !summaryValue) {
    return failure("finding_field_missing", "Finding is missing a required field");
  }

  const severity = SeveritySchema.safeParse(severityValue.toLowerCase());
  if (!severity.success) {
    return failure("invalid_finding_severity", "Finding severity is invalid");
  }
  const file = SafeFindingPathSchema.safeParse(fileValue);
  if (!file.success) {
    return failure("invalid_finding_path", "Finding path is invalid");
  }
  const line = Number.parseInt(lineValue, 10);
  if (!Number.isSafeInteger(line) || line < 1) {
    return failure("invalid_finding_line", "Finding line is invalid");
  }

  return {
    id: heading[1],
    severity: severity.data,
    file: file.data,
    line,
    summary: summaryValue,
    details: details(block),
  };
}

export function parseFindingsMarkdown(markdown: string): FindingsParseSuccess | FindingsParseFailure {
  const section = findingsSection(markdown);
  if (section === null) {
    return failure("findings_section_missing", "Findings section is missing");
  }
  const trimmed = section.trim();
  if (/^(none|no findings)\.?$/i.test(trimmed)) {
    return success([]);
  }

  const headingMatches = [...trimmed.matchAll(/^###\s+Finding\s+[A-Za-z0-9_-]+\s*$/gim)];
  if (headingMatches.length === 0) {
    return failure("finding_block_missing", "Findings section has no structured finding blocks");
  }

  const findings: ParsedFinding[] = [];
  for (let index = 0; index < headingMatches.length; index += 1) {
    const current = headingMatches[index]!;
    const next = headingMatches[index + 1];
    const start = current.index ?? 0;
    const end = next?.index ?? trimmed.length;
    const parsed = parseFindingBlock(trimmed.slice(start, end));
    if ("error" in parsed) return parsed;
    findings.push(parsed);
  }
  return success(findings);
}

export async function parseFindingsFile(path: string): Promise<FindingsParseSuccess | FindingsParseFailure> {
  try {
    return parseFindingsMarkdown(await readFile(path, "utf-8"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return failure("findings_file_missing", "Findings file was not found");
    }
    if (err instanceof Error) {
      console.warn("[findings-parser] Failed to read findings file:", err.message);
    }
    return failure("findings_file_unreadable", "Findings file could not be read");
  }
}
