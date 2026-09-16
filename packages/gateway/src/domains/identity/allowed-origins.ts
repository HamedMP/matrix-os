export function buildAllowedOrigins(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  symphonyPort?: number;
  symphonyPorts?: number[];
}): string[] {
  const symphonyPorts = Array.from(new Set([
    options.symphonyPort,
    ...(options.symphonyPorts ?? []),
  ].filter((port): port is number => typeof port === "number")));
  return Array.from(new Set(
    [
      options.shellOrigin,
      options.proxyOrigin,
      "http://localhost:3000",
      "http://localhost:4001",
      "http://localhost:4766",
      "http://127.0.0.1:4766",
      ...symphonyPorts.flatMap((port) => [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
      ]),
    ].filter((origin): origin is string => Boolean(origin)),
  ));
}

export function createAllowedOriginController(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  symphonyPort?: number;
}) {
  const baseOptions = {
    shellOrigin: options.shellOrigin,
    proxyOrigin: options.proxyOrigin,
  };
  let symphonyPorts = options.symphonyPort ? [options.symphonyPort] : [];
  let allowedOrigins = buildAllowedOrigins({ ...baseOptions, symphonyPorts });

  return {
    resolve(origin: string | undefined): string | undefined {
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
    updateSymphonyPort(port: number, additionalPorts: number[] = []): void {
      symphonyPorts = Array.from(new Set([port, ...additionalPorts]));
      allowedOrigins = buildAllowedOrigins({ ...baseOptions, symphonyPorts });
    },
  };
}
