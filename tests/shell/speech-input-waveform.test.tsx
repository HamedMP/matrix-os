// @vitest-environment jsdom

import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpeechInputWaveform } from "../../packages/ui/src/speech/SpeechInputWaveform.js";

describe("shared speech input waveform", () => {
  it("advances chronological bars when consecutive meter samples have the same level", () => {
    const view = render(<SpeechInputWaveform level={0.7} sampleSequence={1} />);
    view.rerender(<SpeechInputWaveform level={0.7} sampleSequence={2} />);
    view.rerender(<SpeechInputWaveform level={0.7} sampleSequence={3} />);

    const waveform = view.getByTestId("speech-input-waveform");
    const activeBars = Array.from(waveform.children).filter((bar) => Number.parseInt((bar as HTMLElement).style.height, 10) > 3);
    expect(activeBars).toHaveLength(3);
  });

  it("lets the reduced-motion variant remove every bar transition", () => {
    const view = render(<SpeechInputWaveform level={0.5} sampleSequence={1} />);
    const bar = view.getByTestId("speech-input-waveform").firstElementChild;

    expect(bar?.className).toContain("motion-reduce:transition-none");
    expect((bar as HTMLElement).style.transition).toBe("");
  });
});

describe("shared chat speech input button", () => {
  it("paints the recording waveform with the accessible danger text color inline", async () => {
    // packages/ui/src/speech is outside both hosts' Tailwind @source roots, so an
    // arbitrary color class would never be generated and the bars would inherit text color.
    const { ChatSpeechInputButton } = await import("../../packages/ui/src/speech/ChatSpeechInputButton.js");
    const noop = () => {};
    const view = render(
      <ChatSpeechInputButton
        disabled={false}
        speech={{
          phase: "recording", error: null, isSupported: true, previewQuota: null, capabilitiesStale: false,
          elapsedMs: 1_000, inputLevel: 0.5, inputLevelSequence: 1,
          start: async () => {}, stop: noop, cancel: noop, retryCapabilities: async () => {},
        } as unknown as Parameters<typeof ChatSpeechInputButton>[0]["speech"]}
      />,
    );

    const waveform = view.getByTestId("speech-input-waveform");
    expect(waveform.style.color).toBe("var(--danger-text, var(--destructive-text, var(--danger)))");
    expect(waveform.className).not.toMatch(/text-\[/);
  });
});
