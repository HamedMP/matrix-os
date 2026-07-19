// Icon-initial tile for an integration. The desktop never renders remote
// logo URLs (no remote images from the proxy payload) — a deterministic
// initial on the accent token is the whole identity treatment.
export function IntegrationIcon({ name, testId }: { name: string; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
      style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}
