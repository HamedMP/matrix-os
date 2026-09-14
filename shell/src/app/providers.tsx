"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createShellQueryClient } from "@/api/query-client";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createShellQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
