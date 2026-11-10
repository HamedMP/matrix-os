import {
  MAX_USAGE_EVENTS,
  MAX_USAGE_FILES,
  MAX_USAGE_FILE_BYTES,
  readUsageExport,
  readUsageSource,
  type UsageEvent,
} from "@matrix-os/contracts/ai-usage";
async function* fileBytes(file: File, signal: AbortSignal) {
  const reader = file.stream().getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      yield result.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
/** Sequential by design: never buffer multiple large transcripts at once. */
export async function readUsageFiles(files: File[], signal: AbortSignal) {
  if (
    files.length > MAX_USAGE_FILES ||
    files.some((f) => f.size > MAX_USAGE_FILE_BYTES) ||
    files.reduce((n, f) => n + f.size, 0) > 256 * 1024 * 1024
  )
    throw new RangeError("Usage file limit");
  const events: UsageEvent[] = [];
  let issues = 0;
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bound peak memory by reading at most one selected transcript at a time
    const result = file.name.endsWith(".json")
      ? // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential reads bound transcript memory
        readUsageExport(JSON.parse(await file.text()))
      : await readUsageSource(
          fileBytes(file, signal),
          `selected-${file.size}-${file.lastModified}-${index}`,
          signal,
        );
    signal.throwIfAborted();
    events.push(...result.events);
    issues += result.issues;
    if (events.length > MAX_USAGE_EVENTS)
      throw new RangeError("Usage event limit");
  }
  return { events, issues };
}
