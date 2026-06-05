const LEADING_BOOLEAN_GLOBAL_FLAGS = new Set([
  "--json",
  "--dev",
  "--no-color",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
]);

const LEADING_VALUE_GLOBAL_FLAGS = new Set([
  "--profile",
  "--gateway",
  "--platform",
  "--token",
]);

function splitOption(arg: string): string {
  return arg.split("=", 1)[0] ?? arg;
}

function consumeLeadingGlobalFlag(argv: string[], index: number): string[] | null {
  const arg = argv[index];
  if (!arg) {
    return null;
  }

  if (LEADING_BOOLEAN_GLOBAL_FLAGS.has(arg)) {
    return [arg];
  }

  const option = splitOption(arg);
  if (!LEADING_VALUE_GLOBAL_FLAGS.has(option)) {
    return null;
  }

  if (arg.includes("=")) {
    return [arg];
  }

  const value = argv[index + 1];
  if (value === undefined) {
    return [arg];
  }
  return [arg, value];
}

export function normalizeLeadingGlobalFlags(argv: string[]): string[] {
  const leadingFlags: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const consumed = consumeLeadingGlobalFlag(argv, index);
    if (!consumed) {
      break;
    }
    leadingFlags.push(...consumed);
    index += consumed.length;
  }

  if (leadingFlags.length === 0 || index >= argv.length) {
    return argv;
  }

  return [...argv.slice(index), ...leadingFlags];
}
