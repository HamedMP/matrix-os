import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type {
  ConversationProviderCapability,
  ConversationProviderIcon,
  ConversationProviderOption,
} from "./provider-options";

const CAPABILITY_LABEL: Record<ConversationProviderCapability, string> = {
  "current-conversation": "Current conversation",
  "project-conversation": "Project conversation",
  attachments: "Attachments",
  "project-context": "Project context",
  tools: "Tools",
};

export function ConversationProviderSelector({
  value,
  options,
  label = "Chat harness",
  onSelect,
  renderIcon,
}: {
  value: string;
  options: readonly ConversationProviderOption[];
  label?: string;
  onSelect: (providerId: string) => void;
  renderIcon?: (
    icon: ConversationProviderIcon,
    option: ConversationProviderOption,
  ) => ReactNode;
}) {
  const selected = options.find((option) => option.id === value);
  const title = selected
    ? selected.readiness.state === "disabled"
      ? `${selected.label} · ${selected.readiness.reason}`
      : `${selected.label} · ${selected.capabilities.map((capability) => CAPABILITY_LABEL[capability]).join(", ")}`
    : "Choose chat harness";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={title}
          className="inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-full border px-2 text-xs font-medium outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            borderColor: "var(--border-default)",
            background: "var(--bg-surface)",
            color: "var(--text-secondary)",
          }}
        >
          <span className="max-w-24 truncate">{selected?.label ?? "Choose"}</span>
          <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Choose chat harness"
          side="top"
          align="end"
          sideOffset={6}
          className="min-w-48 overflow-hidden rounded-xl border p-1 outline-none"
          style={{
            zIndex: DESKTOP_Z_INDEX.popover,
            borderColor: "var(--border-default)",
            background: "var(--bg-overlay)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(providerId) => {
              const option = options.find((candidate) => candidate.id === providerId);
              if (option?.readiness.state === "ready") onSelect(providerId);
            }}
          >
            {options.map((option) => {
              const disabledReason = option.readiness.state === "disabled"
                ? option.readiness.reason
                : null;
              const disabled = disabledReason !== null;
              return (
                <DropdownMenu.RadioItem
                  key={option.id}
                  value={option.id}
                  disabled={disabled}
                  aria-label={disabled
                    ? `${option.label} ${disabledReason}`
                    : option.label}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2 py-2 text-left outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--bg-hover)]"
                >
                  {renderIcon ? (
                    <span
                      aria-hidden="true"
                      className="flex size-5 shrink-0 items-center justify-center"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {renderIcon(option.icon, option)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span
                      className="block text-xs font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {option.label}
                    </span>
                    {disabled ? (
                      <span
                        className="block text-[10px] leading-4"
                        style={{ color: "var(--text-tertiary)" }}
                      >
                        {disabledReason}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex w-4 shrink-0 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check size={13} style={{ color: "var(--accent)" }} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
