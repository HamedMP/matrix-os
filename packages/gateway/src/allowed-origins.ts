export function buildAllowedOrigins(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  /** A connected computer's platform app origin (spec 2707). */
  platformOrigin?: string;
}): string[] {
  return Array.from(new Set(
    [
      options.shellOrigin,
      options.proxyOrigin,
      options.platformOrigin,
      "http://localhost:3000",
      "http://localhost:4001",
    ].filter((origin): origin is string => Boolean(origin)),
  ));
}

export function createAllowedOriginController(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  platformOrigin?: string;
}) {
  const baseOptions = {
    shellOrigin: options.shellOrigin,
    proxyOrigin: options.proxyOrigin,
    platformOrigin: options.platformOrigin,
  };
  const allowedOrigins = buildAllowedOrigins(baseOptions);

  return {
    resolve(origin: string | undefined): string | undefined {
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
  };
}
