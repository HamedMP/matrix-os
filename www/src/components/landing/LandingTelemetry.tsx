"use client";

import { useEffect } from "react";
import { capturePostHogEvent } from "@/lib/posthog-client";

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
    capturePostHogEvent("marketing_landing_viewed", {
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

      capturePostHogEvent(eventName, {
        surface: "www",
        page: "landing",
        location: target.dataset.phLocation,
        target: target.dataset.phTarget,
        path: window.location.pathname,
      });
    };

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
