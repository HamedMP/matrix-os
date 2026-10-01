/**
 * Scenario registry for the standalone Aoede fixture.
 *
 * Every entry describes (a) the canned canonical detail the fake backend
 * serves, (b) the deterministic server frames the fake media client plays once
 * `startVoice` is invoked, and (c) the DOM drive steps that take the real
 * `ShellAoedeHost` to that state — launcher click → bootstrap, Start →
 * permission, Allow microphone → session frames.
 */
import type { AoedeBootstrapResponse, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import {
  DIGEST_APPLY,
  DIGEST_RUNNING,
  fileReference,
  fixtureActivity,
  fixtureAssistantMessage,
  fixtureCapability,
  fixtureDetail,
  fixtureOperation,
  fixtureUserMessage,
  navigationArtifactOperations,
} from "./payloads";
import type { FixtureVoicePlan, VoiceStep } from "./fixture-media";
import { voiceFrames } from "./fixture-media";

export type DriveStep = "open" | "palette" | "start" | "allow" | "ptt-hold";

export interface ScenarioReady {
  /** `.matrix-aoede[data-state]` value expected once the scenario settles. */
  state?: string;
  /** Panel must be absent (launcher-only). */
  closed?: boolean;
  /** Strings that must appear inside the panel DOM. */
  texts?: string[];
  /** Extra selectors that must resolve inside the panel. */
  selectors?: string[];
}

export interface AoedeScenario {
  id: string;
  label: string;
  /** One-line description rendered in the evidence panel. */
  summary: string;
  bootstrap?: Partial<AoedeBootstrapResponse>;
  detail(): CanonicalChatDetailResponse;
  media?: FixtureVoicePlan;
  drive: DriveStep[];
  ready: ScenarioReady;
}

const UTTERANCE = "Open the timer app on my desktop.";
const RESPONSE = "Done — the timer app is open on your desktop.";
const PROVISIONAL = "Set a reminder for the launch review";

const startedSession: VoiceStep[] = [voiceFrames.listening()];

export const AOEDE_SCENARIOS: readonly AoedeScenario[] = [
  {
    id: "idle",
    label: "Idle (launcher only)",
    summary: "Fresh shell: launcher visible, panel closed, no bootstrap yet — proves Chat is not required.",
    detail: () => fixtureDetail({}),
    drive: [],
    ready: { closed: true },
  },
  {
    id: "permission",
    label: "Permission prompt",
    summary: "Open → explicit Start shows the pre-mic permission gate; startVoice is never called.",
    detail: () => fixtureDetail({}),
    media: { frames: [] },
    drive: ["open", "start"],
    ready: { state: "permission", texts: ["Allow microphone", "Microphone off"] },
  },
  {
    id: "connecting",
    label: "Connecting",
    summary: "Mic granted, session handshake in flight — connecting state before any server frame lands.",
    detail: () => fixtureDetail({}),
    media: { frames: [] },
    drive: ["open", "start", "allow"],
    ready: { state: "connecting", texts: ["Connecting", "Microphone off"] },
  },
  {
    id: "listening",
    label: "Listening",
    summary: "Hands-free capture with a live provisional caption.",
    detail: () => fixtureDetail({}),
    media: { frames: [voiceFrames.provisional(PROVISIONAL), ...startedSession] },
    drive: ["open", "start", "allow"],
    ready: {
      state: "listening",
      texts: ["Provisional utterance", PROVISIONAL],
      selectors: ["[aria-label='Current utterance (provisional)']"],
    },
  },
  {
    id: "captions",
    label: "Captions",
    summary: "Batch-final utterance + response captions after a completed turn. Opens via the command palette — proves launcher/palette converge on one controller.",
    detail: () => fixtureDetail({
      runStatus: "completed",
      messages: [fixtureUserMessage(UTTERANCE), fixtureAssistantMessage(RESPONSE)],
      activities: [
        fixtureActivity({ type: "run.status", status: "completed" }, { id: "activity_run_done" }),
      ],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), ...startedSession] },
    drive: ["palette", "start", "allow"],
    ready: {
      state: "listening",
      texts: [UTTERANCE, RESPONSE, "Completed"],
    },
  },
  {
    id: "thinking",
    label: "Thinking",
    summary: "Run accepted, no output yet — thinking state plus generation cancellation affordance.",
    detail: () => fixtureDetail({
      runStatus: "accepted",
      turnStatus: "accepted",
      messages: [fixtureUserMessage(UTTERANCE)],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), voiceFrames.thinking()] },
    drive: ["open", "start", "allow"],
    ready: { state: "thinking", texts: ["Thinking", "Cancel generation"] },
  },
  {
    id: "tool-activity",
    label: "Tool activity",
    summary: "tool.progress running; the before-dispatch-only operation cannot be cancelled after dispatch.",
    detail: () => fixtureDetail({
      runStatus: "running",
      messages: [fixtureUserMessage(UTTERANCE)],
      activities: [
        fixtureActivity({ type: "run.status", status: "running" }, { id: "activity_run_live" }),
        fixtureActivity(
          { type: "tool.progress", toolCallId: "tool_call_apps_1", label: "List installed apps", status: "running" },
          { id: "activity_tool_apps" },
        ),
      ],
      operations: [
        fixtureOperation({
          id: "action_running_inspect",
          toolId: "matrix_inspect_app",
          state: "running",
          argumentDigest: DIGEST_RUNNING,
        }),
      ],
    }),
    media: { frames: [
      voiceFrames.transcriptFinal(UTTERANCE),
      voiceFrames.usingTool("Inspecting timer sources"),
      { type: "session.state", state: "using_tool" },
    ] },
    drive: ["open", "start", "allow"],
    ready: {
      state: "using_tool",
      texts: ["List installed apps", "matrix_inspect_app", "Cancel generation"],
    },
  },
  {
    id: "speaking",
    label: "Speaking",
    summary: "Response streaming/playback — stop-speaking affordance live.",
    detail: () => fixtureDetail({
      runStatus: "running",
      messages: [fixtureUserMessage(UTTERANCE), fixtureAssistantMessage(RESPONSE)],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), ...voiceFrames.speaking()] },
    drive: ["open", "start", "allow"],
    ready: { state: "speaking", texts: [RESPONSE, "Stop speaking"] },
  },
  {
    id: "approval",
    label: "Approval",
    summary: "Pending approval card with safe description and digest-bound decision buttons.",
    detail: () => fixtureDetail({
      runStatus: "waiting_for_approval",
      attention: "approval_required",
      messages: [fixtureUserMessage(UTTERANCE)],
      activities: [
        fixtureActivity({ type: "run.status", status: "waiting_for_approval" }, { id: "activity_run_wait" }),
        fixtureActivity({
          type: "approval.requested",
          approvalId: "approval_apply_timer",
          title: "Apply timer app files",
          risk: "medium",
          safeDescription: "Create apps/timer with a timer view and manifest.",
          argumentDigest: DIGEST_APPLY,
          allowedDecisions: ["approve", "decline", "cancel"],
        }, { id: "activity_approval_request" }),
      ],
      operations: [
        fixtureOperation({
          id: "action_apply_timer",
          toolId: "matrix_apply_app_files",
          state: "waiting_for_approval",
          argumentDigest: DIGEST_APPLY,
        }),
      ],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), voiceFrames.thinking()] },
    drive: ["open", "start", "allow"],
    ready: {
      state: "thinking",
      texts: ["Your decision is required", "Apply timer app files", "Approve", "Decline", "Waiting for approval"],
    },
  },
  {
    id: "clarification",
    label: "Clarification",
    summary: "input.requested with qualified questions — real CanonicalChatInputForm.",
    detail: () => fixtureDetail({
      runStatus: "waiting_for_input",
      attention: "input_required",
      messages: [fixtureUserMessage("Set up my standup reminder.")],
      activities: [
        fixtureActivity({ type: "run.status", status: "waiting_for_input" }, { id: "activity_run_input" }),
        fixtureActivity({
          type: "input.requested",
          requestId: "inputreq_timer_style",
          title: "Reminder details",
          safeDescription: "Choose the standup reminder cadence.",
          questions: [{
            questionId: "q_cadence",
            header: "Cadence",
            question: "How often should the standup reminder repeat?",
            options: [
              { label: "Daily", description: "Repeat every day" },
              { label: "Weekdays", description: "Repeat Monday through Friday" },
            ],
            multiSelect: false,
            allowOther: true,
            secret: false,
          }],
        }, { id: "activity_input_request" }),
      ],
    }),
    media: { frames: [voiceFrames.transcriptFinal("Set up my standup reminder."), voiceFrames.thinking()] },
    drive: ["open", "start", "allow"],
    ready: { state: "thinking", texts: ["Reminder details", "How often should the standup reminder repeat?", "Weekdays"] },
  },
  {
    id: "navigation-artifact",
    label: "Navigation + artifacts",
    summary: "Operation result projections: open_app navigation, artifact/files, outcome_unknown reconciliation, cancel-requested.",
    detail: () => fixtureDetail({
      runStatus: "completed",
      messages: [
        fixtureUserMessage(UTTERANCE),
        fixtureAssistantMessage(RESPONSE, {
          extraParts: [
            fileReference("apps/timer/App.tsx", "Timer view", "res_timer_app"),
            fileReference("apps/timer/manifest.json", "Timer manifest", "res_timer_manifest"),
          ],
        }),
      ],
      activities: [
        fixtureActivity({ type: "run.status", status: "completed" }, { id: "activity_run_done" }),
        fixtureActivity(
          { type: "tool.progress", toolCallId: "tool_call_apply_1", label: "Apply timer app files", status: "completed" },
          { id: "activity_tool_apply" },
        ),
      ],
      operations: navigationArtifactOperations(),
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), ...startedSession] },
    drive: ["open", "start", "allow"],
    ready: {
      state: "listening",
      texts: [
        "Open timer",
        "apps/timer/App.tsx",
        "Outcome unknown — will be reconciled",
        "Cancel requested",
        "Completed",
      ],
      selectors: ["[aria-label='Action results']", "[aria-label='Results']"],
    },
  },
  {
    id: "reconnect",
    label: "Reconnecting",
    summary: "Transport dropped mid-session — reconnecting/degraded state is truthful, not fatal.",
    detail: () => fixtureDetail({
      runStatus: "running",
      messages: [fixtureUserMessage(UTTERANCE)],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), voiceFrames.listening(), voiceFrames.goingAway()] },
    drive: ["open", "start", "allow"],
    ready: { state: "reconnecting", texts: ["Reconnecting"] },
  },
  {
    id: "ended",
    label: "Ended",
    summary: "Server-authoritative session end — media fully stopped, canonical record retained, Start re-arms.",
    detail: () => fixtureDetail({
      runStatus: "completed",
      messages: [fixtureUserMessage(UTTERANCE), fixtureAssistantMessage(RESPONSE)],
      activities: [
        fixtureActivity({ type: "run.status", status: "completed" }, { id: "activity_run_done" }),
      ],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), voiceFrames.listening(), voiceFrames.ended()] },
    drive: ["open", "start", "allow"],
    ready: { state: "ended", texts: ["Ended", "Microphone off", "Start"] },
  },
  {
    id: "failed",
    label: "Failed",
    summary: "Terminal media failure with a safe error and retry affordance.",
    detail: () => fixtureDetail({
      runStatus: "failed",
      attention: "failed",
      messages: [fixtureUserMessage(UTTERANCE)],
      activities: [
        fixtureActivity({ type: "run.status", status: "failed" }, { id: "activity_run_failed" }),
      ],
    }),
    media: { frames: [voiceFrames.transcriptFinal(UTTERANCE), voiceFrames.listening(), voiceFrames.sessionError()] },
    drive: ["open", "start", "allow"],
    ready: { state: "failed", texts: ["Voice stopped safely", "Retry"] },
  },
  {
    id: "ptt",
    label: "Push to talk",
    summary: "Push-to-talk turn mode: mic stays off until the hold gesture.",
    bootstrap: { capability: fixtureCapability({ turnModes: ["push_to_talk"] }) },
    detail: () => fixtureDetail({}),
    media: { frames: [...startedSession] },
    drive: ["open", "start", "allow", "ptt-hold"],
    ready: { state: "listening", texts: ["Push to talk", "Microphone active"] },
  },
] as const;

export const AOEDE_SCENARIO_IDS = AOEDE_SCENARIOS.map((scenario) => scenario.id);

export function scenarioById(id: string | null): AoedeScenario {
  return AOEDE_SCENARIOS.find((scenario) => scenario.id === id) ?? AOEDE_SCENARIOS[1];
}
