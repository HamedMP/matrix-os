"use client";

import { useEffect } from "react";
import { capturePostHogEvent } from "@/lib/posthog-client";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";

type TrackableElement = HTMLElement & {
  dataset: DOMStringMap & {
    phEvent?: string;
    phLocation?: string;
    phTarget?: string;
  };
};

function isTrackableElement(element: Element | null): element is TrackableElement {
  return element instanceof HTMLElement && typeof element.dataset.phEvent === "string";
}

export function LandingTelemetry() {
  useEffect(() => {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.MARKETING_LANDING_VIEWED, {
      surface: "www",
      page: "landing",
      path: window.location.pathname,
      query_present: Boolean(window.location.search),
    });

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-ph-event]")
        : null;
      if (!isTrackableElement(target)) return;

      const eventName = target.dataset.phEvent;
      if (!eventName) return;
      const targetName = target.dataset.phTarget;
      const resolvedEventName =
        eventName === "marketing_cta_clicked" && (targetName === "get_started" || targetName === "sign_up")
          ? MATRIX_TELEMETRY_EVENTS.MARKETING_SIGNUP_CLICKED
          : eventName;

      capturePostHogEvent(resolvedEventName, {
        surface: "www",
        page: "landing",
        location: target.dataset.phLocation,
        target: targetName,
        path: window.location.pathname,
      });
    };

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
