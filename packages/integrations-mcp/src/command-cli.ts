#!/usr/bin/env node
import { runIntegrationsCommand } from "./command.js";

try {
  const result = await runIntegrationsCommand(process.argv.slice(2));
  process.stdout.write(`${result}\n`);
} catch (err: unknown) {
  console.error(err instanceof Error && err.message.startsWith("Usage:") ? err.message : "Invalid integration command.");
  process.exitCode = 64;
}
