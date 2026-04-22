export function isSafeWebSocketUpgradePath(path: string): boolean {
  return !/[\r\n]/.test(path);
}
