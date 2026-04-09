"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div style={{ display: "flex", height: "100vh", width: "100vw", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Something went wrong</h2>
            <p style={{ fontSize: "0.875rem", color: "#6c7178", marginTop: "0.5rem" }}>{error.message}</p>
            <button
              onClick={reset}
              style={{ marginTop: "1rem", padding: "0.5rem 1rem", borderRadius: "0.375rem", backgroundColor: "#8CC7BE", color: "#1a1f18", border: "none", cursor: "pointer", fontSize: "0.875rem", fontWeight: 500 }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
