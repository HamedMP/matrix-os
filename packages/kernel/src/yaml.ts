export function parse(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "") continue;

    // Array item: "  - value"
    const arrayMatch = trimmed.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(arrayMatch[1].trim());
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    // Key-value: "key: value"
    const kvMatch = trimmed.match(/^(\w[\w]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawVal = kvMatch[2].trim();

      if (rawVal === "") {
        // Might be start of array or nested structure
        currentKey = key;
        continue;
      }

      // Parse value
      const numVal = Number(rawVal);
      if (!Number.isNaN(numVal) && rawVal !== "") {
        result[key] = numVal;
      } else if (rawVal === "true") {
        result[key] = true;
      } else if (rawVal === "false") {
        result[key] = false;
      } else {
        result[key] = rawVal;
      }

      currentKey = key;
      currentArray = null;
    }
  }

  // Flush trailing array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}
