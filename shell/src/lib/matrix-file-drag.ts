import { FileResourceRefSchema } from "@matrix-os/contracts";

const MIME = "application/x-matrix-web-file";
let active: { id: string; path: string; authority: string; gatewayUrl: string } | null = null;

export function startMatrixFileDrag(transfer: DataTransfer, path: string, authority: string, gatewayUrl: string): void {
  active = null;
  if (!FileResourceRefSchema.safeParse({ kind: "home", path }).success) return;
  const id = crypto.randomUUID();
  transfer.effectAllowed = "copy";
  transfer.setData(MIME, id);
  active = { id, path, authority, gatewayUrl };
}

export function endMatrixFileDrag(): void {
  active = null;
}

export function hasMatrixFileDrag(transfer: DataTransfer): boolean {
  return transfer.types?.includes(MIME) ?? false;
}

export function takeMatrixFileDrag(transfer: DataTransfer, authority: string | null, gatewayUrl: string): string | null {
  if (!active || transfer.getData(MIME) !== active.id) return null;
  const file = active;
  active = null;
  return authority && file.authority === authority && file.gatewayUrl === gatewayUrl ? file.path : null;
}
