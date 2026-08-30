export const mobileQueryKeys = {
  activeComputer: (userId: string) => ["mobile", "computers", "active", userId] as const,
  conversations: (userId: string, computerKey: string) => [
    "mobile",
    "conversations",
    userId,
    computerKey,
  ] as const,
  files: (userId: string, computerKey: string, path: string) => [
    "mobile",
    "files",
    userId,
    computerKey,
    path,
  ] as const,
  filePreview: (userId: string, computerKey: string, path: string) => [
    "mobile",
    "files",
    "preview",
    userId,
    computerKey,
    path,
  ] as const,
  terminals: (userId: string, computerKey: string) => [
    "mobile",
    "terminals",
    userId,
    computerKey,
  ] as const,
};
