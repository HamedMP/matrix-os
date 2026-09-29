"use client";

import { SpeechInputWaveform } from "../speech/SpeechInputWaveform.js";
import {
  useVoiceSessionController,
  type VoiceSessionController,
  type VoiceSessionViewState,
} from "./controller.js";
import { VoiceControls } from "./VoiceControls.js";
import "./voice-session.css";

const STATE_LABELS: Record<VoiceSessionViewState["state"], string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  using_tool: "Using tool",
  speaking: "Speaking",
  paused: "Paused",
  reconnecting: "Reconnecting",
  failed: "Failed",
  ended: "Ended",
};

const STATE_DESCRIPTIONS: Record<VoiceSessionViewState["state"], string> = {
  connecting: "Preparing the voice session.",
  listening: "Microphone capture is active.",
  thinking: "Preparing a response.",
  using_tool: "Working with a Matrix capability.",
  speaking: "Playing the response aloud.",
  paused: "Microphone capture is on hold.",
  reconnecting: "Restoring the voice connection.",
  failed: "The voice session needs attention.",
  ended: "Voice capture and playback have stopped.",
};

const ERROR_COPY: Record<string, string> = {
  permission_denied: "Microphone permission is needed. Allow access, then retry.",
  input_unavailable: "No microphone is available. Choose an input, then retry.",
  output_unavailable: "No audio output is available. Choose an output or continue in Chat.",
  connection_failed: "Voice could not connect. Retry or continue in Chat.",
  connection_lost: "The voice connection was lost. Retry or continue in Chat.",
  provider_unavailable: "Voice is temporarily unavailable. Retry or continue in Chat.",
  session_limit_reached: "This voice session reached its limit. Continue in Chat or start again.",
  usage_limit_reached: "Voice usage is currently unavailable. Continue in Chat.",
  audio_backpressure: "Voice input paused because the audio queue filled up. Resume or continue in Chat.",
  chat_unavailable: "This Chat is not available for voice. Continue in Chat.",
  session_conflict: "Another voice session is active. End it before retrying.",
  unsupported_surface: "Voice is not supported here. Continue in Chat.",
  internal_failure: "Voice stopped safely. Retry or continue in Chat.",
};

function activityLevel(state: VoiceSessionViewState): number {
  if (state.state === "listening") return state.pushToTalkActive ? 0.92 : 0.62;
  if (state.state === "speaking") return 0.78;
  if (state.state === "thinking" || state.state === "using_tool") return 0.38;
  return 0.08;
}

export interface VoicePanelProps {
  state: VoiceSessionViewState;
  controller: VoiceSessionController;
  className?: string;
}

export function VoicePanel({ state, controller, className }: VoicePanelProps) {
  const controllerState = useVoiceSessionController(controller);
  const viewState =
    controllerState.epoch > state.epoch ||
    (controllerState.epoch === state.epoch && controllerState.sequence >= state.sequence)
      ? controllerState
      : state;
  const label = STATE_LABELS[viewState.state];
  const classes = ["matrix-voice-panel", className].filter(Boolean).join(" ");

  return (
    <section
      className={classes}
      aria-label="Voice session"
      data-state={viewState.state}
    >
      <div className="matrix-voice-panel__status" role="status" aria-live="polite" aria-atomic="true">
        <div className="matrix-voice-panel__status-copy">
          <p className="matrix-voice-panel__eyebrow">Voice in Chat</p>
          <h2 className="matrix-voice-panel__title">{label}</h2>
          <p className="matrix-voice-panel__description">
            {viewState.state === "using_tool" && viewState.toolLabel
              ? `${STATE_DESCRIPTIONS.using_tool} ${viewState.toolLabel}.`
              : STATE_DESCRIPTIONS[viewState.state]}
          </p>
        </div>
        <div className="matrix-voice-panel__waveform-band" aria-hidden="true">
          <SpeechInputWaveform
            className="matrix-voice-panel__waveform"
            level={activityLevel(viewState)}
            sampleSequence={viewState.sequence}
          />
        </div>
      </div>

      {viewState.provisionalTranscript ? (
        <section
          className="matrix-voice-panel__transcript"
          aria-label="Draft transcript"
        >
          <h3>Draft transcript</h3>
          <p>{viewState.provisionalTranscript.text}</p>
        </section>
      ) : null}

      {viewState.state === "failed" ? (
        <p className="matrix-voice-panel__error" role="alert" aria-live="assertive">
          {ERROR_COPY[viewState.error?.code ?? "internal_failure"] ?? ERROR_COPY.internal_failure}
        </p>
      ) : null}

      <VoiceControls state={viewState} controller={controller} />
    </section>
  );
}
