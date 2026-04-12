import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Matrix OS. Your AI operating system.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "#FAFAF9",
          fontFamily: "system-ui, sans-serif",
          position: "relative",
        }}
      >
        {/* Subtle dot pattern */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "radial-gradient(circle, rgba(50,61,46,0.08) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />

        {/* Wordmark */}
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#1C1917",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            marginBottom: 48,
          }}
        >
          Matrix OS
        </div>

        {/* Tagline */}
        <div
          style={{
            fontSize: 56,
            fontWeight: 300,
            color: "#1C1917",
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
            textAlign: "center",
            marginBottom: 20,
          }}
        >
          Your AI operating system
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: 24,
            color: "#6A8A7A",
            textAlign: "center",
            maxWidth: 600,
            lineHeight: 1.4,
          }}
        >
          Describe what you need. Watch it appear.
        </div>

        {/* Bottom bar */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            display: "flex",
            alignItems: "center",
            gap: 24,
            fontSize: 14,
            color: "#9AA48C",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          <span>Claude Opus 4.6</span>
          <span style={{ color: "#E5E5E4" }}>|</span>
          <span>Agent SDK</span>
          <span style={{ color: "#E5E5E4" }}>|</span>
          <span>matrix-os.com</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
