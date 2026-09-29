"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "../Button.js";
import type {
  VoiceSessionController,
  VoiceSessionViewState,
} from "./controller.js";

export interface VoiceControlsProps {
  state: VoiceSessionViewState;
  controller: VoiceSessionController;
}

function PushToTalkButton({
  active,
  controller,
}: {
  active: boolean;
  controller: VoiceSessionController;
}) {
  const suppressClick = useRef(false);

  const start = () => controller.beginPushToTalk();
  const stop = () => controller.endPushToTalk();

  // Capture must not outlive an engaged control: releasing focus, hiding the
  // page, or unmounting the button all end the hold and emit capture.stop.
  useEffect(() => {
    if (!active) return undefined;
    const release = () => controller.endPushToTalk();
    const onVisibility = () => {
      if (document.hidden) controller.endPushToTalk();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active, controller]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    suppressClick.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start();
  };
  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    stop();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== " " && event.key !== "Enter") || event.repeat) return;
    event.preventDefault();
    suppressClick.current = true;
    start();
  };
  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    stop();
  };

  return (
    <Button
      variant={active ? "primary" : "secondary"}
      className="matrix-voice-control matrix-voice-control--push-to-talk"
      aria-pressed={active}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onBlur={() => {
        // Losing focus terminates the hold and the interaction itself, so any
        // pending click suppression tied to that gesture is released too.
        suppressClick.current = false;
        stop();
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (active) stop();
        else start();
      }}
    >
      Push to Talk
    </Button>
  );
}

export function VoiceControls({ state, controller }: VoiceControlsProps) {
  const terminal = state.state === "ended";
  const failed = state.state === "failed";
  const paused = state.state === "paused";
  const mayPause =
    state.state === "listening" ||
    state.state === "thinking" ||
    state.state === "using_tool" ||
    state.state === "speaking";

  return (
    <div className="matrix-voice-controls" role="group" aria-label="Voice session controls">
      {paused ? (
        <Button className="matrix-voice-control" onClick={() => controller.resume()}>
          Resume
        </Button>
      ) : null}
      {mayPause ? (
        <Button
          variant="secondary"
          className="matrix-voice-control"
          onClick={() => controller.pause()}
        >
          Hold
        </Button>
      ) : null}
      {state.state === "speaking" ? (
        <Button
          variant="secondary"
          className="matrix-voice-control"
          onClick={() => controller.stopSpeaking()}
        >
          Stop speaking
        </Button>
      ) : null}
      {state.turnMode === "push_to_talk" && state.state === "listening" ? (
        <PushToTalkButton active={state.pushToTalkActive} controller={controller} />
      ) : null}
      {failed ? (
        <>
          {state.error?.retryable !== false ? (
            <Button className="matrix-voice-control" onClick={() => controller.retry()}>
              Retry
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="matrix-voice-control"
            onClick={() => controller.continueInChat()}
          >
            Continue in Chat
          </Button>
        </>
      ) : null}
      {terminal ? (
        <Button
          variant="secondary"
          className="matrix-voice-control"
          onClick={() => controller.continueInChat()}
        >
          Continue in Chat
        </Button>
      ) : (
        <Button
          variant="ghost"
          className="matrix-voice-control matrix-voice-control--end"
          onClick={() => controller.end()}
        >
          End
        </Button>
      )}
    </div>
  );
}
