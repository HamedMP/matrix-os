export function buildAllowedOrigins(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
}): string[] {
  return Array.from(new Set(
    [
      options.shellOrigin,
      options.proxyOrigin,
      "http://localhost:3000",
      "http://localhost:4001",
    ].filter((origin): origin is string => Boolean(origin)),
  ));
}

export function createAllowedOriginController(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
}) {
  const baseOptions = {
    shellOrigin: options.shellOrigin,
    proxyOrigin: options.proxyOrigin,
  };
  const allowedOrigins = buildAllowedOrigins(baseOptions);

  return {
    resolve(origin: string | undefined): string | undefined {
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
  };
}
