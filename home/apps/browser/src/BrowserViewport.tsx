import type { BrowserConnectionState } from "./useBrowserSession";
import type { PointerEvent, WheelEvent } from "react";

export function BrowserViewport(props: {
  state: BrowserConnectionState;
  error: string | null;
  url: string;
  frameDataUrl?: string | null;
  onTakeover?: () => void;
  onFocusSurface?: () => void;
  onPointerInput?: (input: {
    kind: "down" | "up" | "move" | "wheel";
    x: number;
    y: number;
    button: "left" | "middle" | "right" | "none";
    deltaX?: number;
    deltaY?: number;
  }) => void;
  onKeyboardInput?: (input: { kind: "keydown" | "keyup"; key: string; code: string; text: string }) => void;
  onPasteInput?: (text: string) => void;
  onImeInput?: (kind: "compositionstart" | "compositionupdate" | "compositionend", text: string) => void;
}) {
  if (props.state === "locked") {
    return (
      <section className="browser-viewport" aria-label="Browser viewport" data-state="locked">
        <div className="browser-state">
          <h1>Browser open elsewhere</h1>
          <p>{props.error ?? "This profile is already active on another device."}</p>
          <button type="button" onClick={props.onTakeover}>Take over</button>
        </div>
      </section>
    );
  }

  if (props.state === "hibernated" || props.state === "recoverable") {
    return (
      <section className="browser-viewport" aria-label="Browser viewport" data-state={props.state}>
        <div className="browser-state">
          <h1>{props.state === "hibernated" ? "Browser hibernated" : "Browser can be restored"}</h1>
          <p>{props.state === "hibernated" ? "Tabs reopen from saved URLs. Page scripts and transient form state will run again." : "The previous runtime stopped before preserving transient page state."}</p>
        </div>
      </section>
    );
  }

  if (props.state === "limit") {
    return (
      <section className="browser-viewport" aria-label="Browser viewport" data-state="limit">
        <div className="browser-state">
          <h1>Browser limit reached</h1>
          <p>{props.error ?? "Close another Browser surface or clear downloads before trying again."}</p>
        </div>
      </section>
    );
  }

  if (props.state === "error") {
    return (
      <section className="browser-viewport" aria-label="Browser viewport" data-state="error">
        <div className="browser-state">
          <h1>Browser unavailable</h1>
          <p>{props.error ?? "Browser is unavailable right now."}</p>
        </div>
      </section>
    );
  }

  if (props.state === "stream-pending" || props.state === "connected") {
    return (
      <section className="browser-viewport" aria-label="Browser surface" data-state={props.state}>
        <div
          className="browser-frame"
          role="region"
          aria-label="Browser viewport"
          tabIndex={0}
          onFocus={props.onFocusSurface}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = viewportPoint(event);
            props.onPointerInput?.({
              kind: "down",
              ...point,
              button: pointerButton(event.button),
            });
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            const point = viewportPoint(event);
            props.onPointerInput?.({
              kind: "up",
              ...point,
              button: pointerButton(event.button),
            });
          }}
          onPointerMove={(event) => {
            const point = viewportPoint(event);
            props.onPointerInput?.({
              kind: "move",
              ...point,
              button: "none",
            });
          }}
          onWheel={(event) => {
            event.preventDefault();
            const point = viewportPoint(event);
            props.onPointerInput?.({
              kind: "wheel",
              ...point,
              button: "none",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
          }}
          onKeyDown={(event) => {
            event.preventDefault();
            props.onKeyboardInput?.({
              kind: "keydown",
              key: event.key,
              code: event.code,
              text: event.key.length === 1 ? event.key : "",
            });
          }}
          onKeyUp={(event) => {
            event.preventDefault();
            props.onKeyboardInput?.({
              kind: "keyup",
              key: event.key,
              code: event.code,
              text: "",
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            props.onPasteInput?.(event.clipboardData.getData("text/plain"));
          }}
          onCompositionStart={(event) => props.onImeInput?.("compositionstart", event.data)}
          onCompositionUpdate={(event) => props.onImeInput?.("compositionupdate", event.data)}
          onCompositionEnd={(event) => props.onImeInput?.("compositionend", event.data)}
        >
          <div className="browser-frame-bar">{props.url}</div>
          {props.frameDataUrl ? (
            <img
              className="browser-frame-image"
              src={props.frameDataUrl}
              alt=""
              draggable={false}
            />
          ) : (
            <div className="browser-stream-placeholder">
              <h1>{props.state === "connected" ? "Browser stream connected" : "WebRTC stream pending"}</h1>
              <p>Waiting for the owner VPS Chromium frame.</p>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="browser-viewport" aria-label="Browser viewport" data-state={props.state}>
      <div className="browser-state">
        <h1>{props.state === "starting" ? "Starting Browser" : "No page loaded"}</h1>
        <p>{props.state === "starting" ? "Opening the owner-hosted Chromium runtime." : "Enter a URL to open a VPS-hosted browser session."}</p>
      </div>
    </section>
  );
}

function viewportPoint(event: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(3840, Math.round(event.clientX - rect.left))),
    y: Math.max(0, Math.min(2160, Math.round(event.clientY - rect.top))),
  };
}

function pointerButton(button: number): "left" | "middle" | "right" | "none" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}
