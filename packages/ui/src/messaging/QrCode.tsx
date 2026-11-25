import { encode } from "uqr";

function qrPath(value: string): { path: string; size: number } | null {
  try {
    const qr = encode(value, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path, size: qr.size };
  } catch (error: unknown) {
    console.warn("[messaging] QR code could not be encoded", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

/**
 * Renders a scannable QR code as inline SVG. Scanners need dark modules on a
 * light field in every theme, so the colours are fixed rather than themed.
 */
export function QrCode({ value, label, size = 232 }: { value: string; label: string; size?: number }) {
  const qr = qrPath(value);
  if (!qr) return <p role="alert">The code could not be shown. Close this window and try again.</p>;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      style={{ display: "block", borderRadius: "var(--matrix-radius-md)" }}
    >
      <rect width={qr.size} height={qr.size} fill="white" />
      <path d={qr.path} fill="black" />
    </svg>
  );
}
