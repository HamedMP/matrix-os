export function getMissingFileFallback(filePath: string): { body: string; contentType: string } | null {
  if (filePath === "system/modules.json") {
    return { body: "[]", contentType: "application/json" };
  }
  return null;
}
