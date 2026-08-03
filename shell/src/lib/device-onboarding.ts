export function normalizeDeviceReturnPath(value: string | null): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(value, "https://app.matrix-os.com");
    if (url.pathname !== "/auth/device") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    console.warn(
      "[billing] invalid device return path",
      error instanceof Error ? error.name : typeof error,
    );
    return null;
  }
}

export function buildDeviceBootHandoffPath(
  deviceReturnPath: string,
  runtime: string | null = null,
): string {
  const searchParams = new URLSearchParams();
  if (runtime) searchParams.set("runtime", runtime);
  searchParams.set("device_return", deviceReturnPath);
  return `/?${searchParams.toString()}`;
}
