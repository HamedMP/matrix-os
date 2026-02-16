const ENV_REF_PATTERN = /^\$\{(\w+)\}$/;
const ESCAPE_PATTERN = /^\$\$\{(\w+)\}$/;

export function restoreEnvVarRefs(
  resolved: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(resolved)) {
    const rVal = resolved[key];
    const oVal = original[key];

    if (oVal === undefined) {
      result[key] = rVal;
      continue;
    }

    if (Array.isArray(rVal) && Array.isArray(oVal)) {
      result[key] = rVal.map((item, i) => {
        const origItem = oVal[i];
        if (typeof item === "string" && typeof origItem === "string") {
          return restoreStringValue(item, origItem);
        }
        return item;
      });
    } else if (isPlainObject(rVal) && isPlainObject(oVal)) {
      result[key] = restoreEnvVarRefs(
        rVal as Record<string, unknown>,
        oVal as Record<string, unknown>,
      );
    } else if (typeof rVal === "string" && typeof oVal === "string") {
      result[key] = restoreStringValue(rVal, oVal);
    } else {
      result[key] = rVal;
    }
  }

  return result;
}

function restoreStringValue(resolved: string, original: string): string {
  if (ESCAPE_PATTERN.test(original)) {
    return original;
  }

  const match = ENV_REF_PATTERN.exec(original);
  if (match) {
    const envName = match[1];
    const envValue = process.env[envName];
    if (envValue === resolved) {
      return original;
    }
  }

  return resolved;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
