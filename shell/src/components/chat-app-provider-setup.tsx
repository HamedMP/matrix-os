"use client";

import { useEffect, useState } from "react";
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { CheckIcon, CalendarIcon, GithubIcon, MailIcon, MessageSquareIcon } from "@/lib/hugeicons";
import {
  deriveReadyModelChoices,
  loadAiProviderSnapshot,
  type ReadyAiModelChoice,
} from "@/lib/ai-providers";

const PROVIDER_SELECTION_STORAGE_KEY = "matrix:chat-provider-selection";
const CHANNEL_OPTIONS = [
  { id: "shell", label: "Shell", icon: MessageSquareIcon },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "github", label: "GitHub", icon: GithubIcon },
];

function choiceKey(choice: Pick<ReadyAiModelChoice, "instanceId" | "modelId">): string {
  return `${choice.instanceId}:${choice.modelId}`;
}

function readSavedChoice(): string {
  if (typeof window === "undefined") return "";
  const value = window.localStorage.getItem(PROVIDER_SELECTION_STORAGE_KEY);
  return typeof value === "string" && value.length <= 320 ? value : "";
}

export function useChatProviderState() {
  const [snapshot, setSnapshot] = useState<AiProviderSnapshotV3 | null>(null);
  const [savedChoice, setSavedChoice] = useState(readSavedChoice);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadAiProviderSnapshot()
      .then((value) => {
        if (!cancelled) {
          setSnapshot(value);
          setUnavailable(false);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          "[chat] Failed to load AI provider state:",
          error instanceof Error ? error.name : "UnknownError",
        );
        if (!cancelled) setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choices = snapshot ? deriveReadyModelChoices(snapshot) : [];
  const activeKey = snapshot?.active.providerInstanceId && snapshot.active.modelId
    ? `${snapshot.active.providerInstanceId}:${snapshot.active.modelId}`
    : "";
  const selected = choices.find((choice) => choiceKey(choice) === savedChoice)
    ?? choices.find((choice) => choiceKey(choice) === activeKey)
    ?? choices[0]
    ?? null;

  const select = (choice: ReadyAiModelChoice) => {
    const key = choiceKey(choice);
    setSavedChoice(key);
    try {
      window.localStorage.setItem(PROVIDER_SELECTION_STORAGE_KEY, key);
    } catch (error) {
      console.warn(
        "[chat] Failed to save provider selection:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  };

  const activeInstance = snapshot?.instances.find((instance) => instance.id === selected?.instanceId);
  const activeDriver = snapshot?.drivers.find((driver) => driver.id === activeInstance?.driverId);
  return {
    snapshot,
    choices,
    selected,
    select,
    loading,
    unavailable,
    activeDriver,
  };
}

export function ChatProviderSetupPanel({
  snapshot,
  choices,
  selected,
  onSelect,
  channels,
  onToggleChannel,
}: {
  snapshot: AiProviderSnapshotV3 | null;
  choices: ReadyAiModelChoice[];
  selected: ReadyAiModelChoice | null;
  onSelect: (choice: ReadyAiModelChoice) => void;
  channels: Set<string>;
  onToggleChannel: (channel: string) => void;
}) {
  return (
    <section className="border-b border-border/30 bg-muted/30 px-3 py-3">
      <div className="mx-auto grid w-full max-w-[720px] gap-3 md:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Model and access</p>
          <div className="space-y-1.5">
            {choices.map((choice) => {
              const isSelected = choice.instanceId === selected?.instanceId
                && choice.modelId === selected.modelId;
              return (
                <button
                  key={`${choice.instanceId}:${choice.modelId}`}
                  type="button"
                  aria-label={`${choice.modelLabel} via ${choice.accessSourceLabel}`}
                  onClick={() => onSelect(choice)}
                  className={`flex min-h-11 w-full items-center justify-between rounded-md border px-2.5 text-left text-xs transition ${
                    isSelected
                      ? "border-primary/35 bg-primary/10 text-foreground"
                      : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{choice.modelLabel}</span>
                    <span className="flex gap-1 text-[10px] text-muted-foreground">
                      <span className="truncate">{choice.accessSourceLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{choice.fundingLabel}</span>
                    </span>
                  </span>
                  {isSelected && <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
            {choices.length === 0 && (
              <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                Connect a provider in Settings to start chatting.
              </p>
            )}
          </div>
          {snapshot && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
              {snapshot.accounts.map((account) => (
                <span key={account.id}>
                  {account.vendor === "openrouter" ? "OpenRouter" : "Anthropic"}: {account.state === "setup_required" ? "Not connected" : account.state.replaceAll("_", " ")}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Channels</p>
          <div className="grid grid-cols-2 gap-1.5">
            {CHANNEL_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isSelected = channels.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onToggleChannel(option.id)}
                  className={`flex min-h-11 items-center gap-2 rounded-md border px-2.5 text-xs transition ${
                    isSelected
                      ? "border-primary/35 bg-primary/10 text-foreground"
                      : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
