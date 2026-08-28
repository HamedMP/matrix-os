import { getIcon } from "material-file-icons";

export function FileTypeIcon({ filename, size = 16 }: { filename: string; size?: number }) {
  const svg = getIcon(filename).svg;
  return (
    <img
      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className="shrink-0"
    />
  );
}
