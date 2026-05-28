import React from "react";
import { Text } from "ink";
import type { TuiOverallState } from "../status.js";

export function Mascot({ state, noColor }: { state: TuiOverallState; noColor?: boolean }) {
  const face = state === "healthy" ? "[::]" : state === "unauthenticated" ? "[??]" : "[!!]";
  return <Text color={noColor ? undefined : state === "healthy" ? "green" : "yellow"}>{face}</Text>;
}
