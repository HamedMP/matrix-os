interface MatrixOS {
  gatewayFetch?<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  theme?: Record<string, string>;
  app?: { name: string };
}

declare global {
  interface Window {
    MatrixOS?: MatrixOS;
  }
}

export {};
