import {
  Check,
  ChevronRight,
  Eye,
  FilePenLine,
  LoaderCircle,
  Minus,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Marker, MarkerContent, MarkerIcon } from "./marker";

export type ToolActivityState = "running" | "done" | "stopped";

interface ToolActivityPresentation {
  icon: LucideIcon;
  label: string;
  preview?: string;
}

const MAX_PREVIEW_CHARS = 140;
const MAX_DETAIL_CHARS = 8_000;

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}…`
    : normalized;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function activityPresentation(
  tool: string,
  state: ToolActivityState,
  input?: Record<string, unknown>,
): ToolActivityPresentation {
  const normalized = tool.toLowerCase();
  const command = boundedText(input?.command, MAX_PREVIEW_CHARS);
  const rawPath = boundedText(input?.file_path ?? input?.path, MAX_PREVIEW_CHARS);
  const query = boundedText(input?.query ?? input?.pattern, MAX_PREVIEW_CHARS);
  const description = boundedText(input?.description, MAX_PREVIEW_CHARS);

  if (/bash|shell|command|terminal|exec|run/.test(normalized)) {
    return {
      icon: SquareTerminal,
      label: state === "running" ? "Running command" : state === "stopped" ? "Stopped command" : "Ran command",
      preview: command ?? description,
    };
  }
  if (normalized === "toolsearch" || normalized.includes("tool_search")) {
    return {
      icon: Search,
      label: state === "running" ? "Searching tools" : state === "stopped" ? "Stopped tool search" : "Searched tools",
      preview: query,
    };
  }
  if (/read|view|open/.test(normalized)) {
    return {
      icon: Eye,
      label: state === "running" ? "Reading" : state === "stopped" ? "Stopped reading" : "Read file",
      preview: rawPath ? basename(rawPath) : description,
    };
  }
  if (/grep|glob|search|find/.test(normalized)) {
    return {
      icon: Search,
      label: state === "running" ? "Searching" : state === "stopped" ? "Stopped search" : "Searched",
      preview: query ?? rawPath ?? description,
    };
  }
  if (/write|edit|apply|patch|create/.test(normalized)) {
    return {
      icon: FilePenLine,
      label: state === "running" ? "Editing" : state === "stopped" ? "Stopped editing" : "Edited files",
      preview: rawPath ? basename(rawPath) : description,
    };
  }
  return {
    icon: Wrench,
    label: state === "running" ? `Using ${tool}` : state === "stopped" ? `Stopped ${tool}` : `Used ${tool}`,
    preview: description ?? query ?? rawPath,
  };
}

function toolDetail(input?: Record<string, unknown>): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const detail = JSON.stringify(input, null, 2);
  return detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}\n…`
    : detail;
}

export function Tool({
  tool,
  state,
  input,
}: {
  tool: string;
  state: ToolActivityState;
  input?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const presentation = activityPresentation(tool, state, input);
  const detail = toolDetail(input);
  const Icon = presentation.icon;
  const accessibleLabel = presentation.preview
    ? `${presentation.label}: ${presentation.preview}`
    : presentation.label;

  return (
    <div className="flex min-w-0 flex-col">
      <Marker asChild>
        <button
          type="button"
          onClick={() => detail && setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={accessibleLabel}
          className="rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)]"
        >
          <MarkerIcon>
            <Icon className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
          </MarkerIcon>
          <MarkerContent className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-medium text-[var(--text-primary)]">{presentation.label}</span>
            {presentation.preview ? (
              <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">
                {presentation.preview}
              </span>
            ) : null}
          </MarkerContent>
          {state === "running" ? (
            <LoaderCircle aria-hidden className="status-pulse size-3.5 shrink-0" />
          ) : state === "stopped" ? (
            <Minus aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <Check aria-hidden className="size-3.5 shrink-0" />
          )}
          {detail ? (
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0"
              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}
            />
          ) : null}
        </button>
      </Marker>
      {open && detail ? (
        <pre
          className="mt-1 ml-7 overflow-x-auto border-l pl-3 font-mono text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
