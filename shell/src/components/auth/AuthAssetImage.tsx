import Image from "next/image";
import type { CSSProperties } from "react";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";

interface AuthAssetImageProps {
  src: `/${string}`;
  alt: string;
  width: number;
  height: number;
  className: string;
  style?: CSSProperties;
}

export function AuthAssetImage({
  src,
  alt,
  width,
  height,
  className,
  style,
}: AuthAssetImageProps) {
  return (
    <Image
      src={platformShellAssetPath(src)}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style}
      unoptimized
    />
  );
}
