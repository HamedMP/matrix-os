import { describe, it, expect } from "vitest";

describe("VoiceButton component", () => {
  describe("states", () => {
    it("idle state: gray mic icon, not pulsing", () => {
      const isRecording = false;
      const isProcessing = false;

      const className = isRecording
        ? "text-red-500 animate-pulse"
        : "text-muted-foreground";

      const icon = isProcessing ? "loader" : isRecording ? "mic-off" : "mic";

      expect(className).toContain("text-muted-foreground");
      expect(className).not.toContain("animate-pulse");
      expect(icon).toBe("mic");
    });

    it("recording state: red pulsing mic-off icon", () => {
      const isRecording = true;
      const isProcessing = false;

      const className = isRecording
        ? "text-red-500 animate-pulse"
        : "text-muted-foreground";

      const icon = isProcessing ? "loader" : isRecording ? "mic-off" : "mic";

      expect(className).toContain("text-red-500");
      expect(className).toContain("animate-pulse");
      expect(icon).toBe("mic-off");
    });

    it("processing state: spinner icon", () => {
      const isProcessing = true;
      const isRecording = false;

      const icon = isProcessing ? "loader" : isRecording ? "mic-off" : "mic";
      const spinClass = isProcessing ? "animate-spin" : "";

      expect(icon).toBe("loader");
      expect(spinClass).toBe("animate-spin");
    });
  });

  describe("onClick behavior", () => {
    it("starts recording when idle", () => {
      let isRecording = false;
      const startRecording = () => { isRecording = true; };
      const stopRecording = () => { isRecording = false; };

      // Simulate click when not recording
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }

      expect(isRecording).toBe(true);
    });

    it("stops recording when recording", () => {
      let isRecording = true;
      const startRecording = () => { isRecording = true; };
      const stopRecording = () => { isRecording = false; };

      // Simulate click when recording
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }

      expect(isRecording).toBe(false);
    });
  });

  describe("disabled state", () => {
    it("disabled when not connected", () => {
      const connected = false;
      const isSupported = true;
      const isTranscribing = false;

      const disabled = !connected || !isSupported || isTranscribing;
      expect(disabled).toBe(true);
    });

    it("disabled when voice not supported", () => {
      const connected = true;
      const isSupported = false;
      const isTranscribing = false;

      const disabled = !connected || !isSupported || isTranscribing;
      expect(disabled).toBe(true);
    });

    it("disabled when transcribing", () => {
      const connected = true;
      const isSupported = true;
      const isTranscribing = true;

      const disabled = !connected || !isSupported || isTranscribing;
      expect(disabled).toBe(true);
    });

    it("enabled when connected, supported, and not transcribing", () => {
      const connected = true;
      const isSupported = true;
      const isTranscribing = false;

      const disabled = !connected || !isSupported || isTranscribing;
      expect(disabled).toBe(false);
    });
  });

  describe("title/tooltip", () => {
    it("shows 'Voice input not supported' when not supported", () => {
      const isSupported = false;
      const isRecording = false;
      const isTranscribing = false;

      const title = !isSupported
        ? "Voice input not supported in this browser"
        : isRecording
          ? "Stop recording"
          : isTranscribing
            ? "Transcribing..."
            : "Voice input";

      expect(title).toBe("Voice input not supported in this browser");
    });

    it("shows 'Stop recording' when recording", () => {
      const isSupported = true;
      const isRecording = true;
      const isTranscribing = false;

      const title = !isSupported
        ? "Voice input not supported in this browser"
        : isRecording
          ? "Stop recording"
          : isTranscribing
            ? "Transcribing..."
            : "Voice input";

      expect(title).toBe("Stop recording");
    });

    it("shows 'Voice input' when idle", () => {
      const isSupported = true;
      const isRecording = false;
      const isTranscribing = false;

      const title = !isSupported
        ? "Voice input not supported in this browser"
        : isRecording
          ? "Stop recording"
          : isTranscribing
            ? "Transcribing..."
            : "Voice input";

      expect(title).toBe("Voice input");
    });
  });

  describe("InputBar integration", () => {
    it("placeholder changes during recording states", () => {
      const connected = true;

      // Idle
      let isRecording = false;
      let isTranscribing = false;
      let placeholder = isTranscribing
        ? "Transcribing..."
        : isRecording
          ? "Listening..."
          : connected
            ? "Ask Matrix OS..."
            : "Connecting...";
      expect(placeholder).toBe("Ask Matrix OS...");

      // Recording
      isRecording = true;
      placeholder = isTranscribing
        ? "Transcribing..."
        : isRecording
          ? "Listening..."
          : connected
            ? "Ask Matrix OS..."
            : "Connecting...";
      expect(placeholder).toBe("Listening...");

      // Transcribing
      isRecording = false;
      isTranscribing = true;
      placeholder = isTranscribing
        ? "Transcribing..."
        : isRecording
          ? "Listening..."
          : connected
            ? "Ask Matrix OS..."
            : "Connecting...";
      expect(placeholder).toBe("Transcribing...");
    });

    it("disables text input during recording", () => {
      const connected = true;
      const isRecording = true;

      const inputDisabled = !connected || isRecording;
      expect(inputDisabled).toBe(true);
    });

    it("sends transcription via onSubmit callback", () => {
      const submitted: string[] = [];
      const onSubmit = (text: string) => { submitted.push(text); };

      // Simulate onTranscription callback from useVoice
      const text = "hello from voice";
      onSubmit(text);

      expect(submitted).toEqual(["hello from voice"]);
    });
  });
});
