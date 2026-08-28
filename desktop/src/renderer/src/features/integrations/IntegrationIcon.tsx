import { useRef, useState } from "react";

// Mirrors the webview's Pipedream logo treatment with a deterministic initial
// fallback when a logo is unavailable or fails to load.
export function IntegrationIcon({ name, logoUrl, testId }: { name: string; logoUrl?: string; testId?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const previousLogoUrl = useRef<string | undefined>(undefined);
  if (previousLogoUrl.current !== logoUrl) {
    previousLogoUrl.current = logoUrl;
    if (imgFailed) setImgFailed(false);
  }

  if (logoUrl && !imgFailed) {
    return (
      <div
        data-testid={testId ? `${testId}-container` : undefined}
        className="flex size-11 shrink-0 items-center justify-center rounded-[10px] p-2.5"
        style={{ background: "var(--surface-card-foreground-subtle, #FAFAF6)" }}
      >
        {/* Some provider SVGs advertise narrow intrinsic dimensions (for
            example 8x20). Fill the fixed icon slot so those assets do not
            render as tiny slivers inside the 44px icon container. */}
        <img
          data-testid={testId}
          src={logoUrl}
          alt={name}
          width={24}
          height={24}
          className="size-6 object-fill"
          onError={() => setImgFailed(true)}
        />
      </div>
    );
  }

  return (
    <div
      data-testid={testId ? `${testId}-container` : undefined}
      className="flex size-11 shrink-0 items-center justify-center rounded-[10px] p-2.5"
      style={{ background: "var(--surface-card-foreground-subtle, #FAFAF6)" }}
    >
      <span data-testid={testId} className="text-sm font-semibold" style={{ color: "var(--accent)" }} aria-hidden>
        {name.charAt(0).toUpperCase() || "?"}
      </span>
    </div>
  );
}
