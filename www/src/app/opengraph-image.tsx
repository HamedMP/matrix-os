import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Matrix OS. The OS that builds itself.";
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
          background: "#ece5f0",
          fontFamily: "system-ui, sans-serif",
          position: "relative",
        }}
      >
        {/* Subtle grid pattern */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(200,184,208,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(200,184,208,0.3) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />

        {/* Logo */}
        <img
          src="https://matrix-os.com/logo.png"
          width={100}
          height={100}
          style={{
            borderRadius: 24,
            marginBottom: 32,
          }}
        />

        {/* Title */}
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: "#1c1917",
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            textAlign: "center",
            marginBottom: 16,
          }}
        >
          Matrix OS
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: 28,
            color: "#78716c",
            textAlign: "center",
            maxWidth: 600,
            lineHeight: 1.4,
          }}
        >
          The OS that builds itself
        </div>

        {/* Bottom bar */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            display: "flex",
            alignItems: "center",
            gap: 24,
            fontSize: 16,
            color: "#78716c",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          <span>Claude Opus 4.6</span>
          <span style={{ color: "#d8d0de" }}>|</span>
          <span>Agent SDK</span>
          <span style={{ color: "#d8d0de" }}>|</span>
          <span>matrix-os.com</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
