import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { desktopQueryClient } from "./lib/query-client";

export function NormalDesktop() {
  return <QueryClientProvider client={desktopQueryClient}><App /></QueryClientProvider>;
}
