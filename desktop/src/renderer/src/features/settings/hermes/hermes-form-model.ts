import {
  HermesConfigValueSchema,
  type HermesConfiguration,
  type HermesEnvironment,
} from "@matrix-os/contracts";

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function configValueAt(config: Record<string, unknown>, path: string): unknown {
  let value: unknown = config;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function setConfigValue(
  config: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const next = structuredClone(config);
  const segments = path.split(".");
  let target = next;
  for (const segment of segments.slice(0, -1)) {
    const child = target[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      target[segment] = {};
    }
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] = value;
  return next;
}

export function configurationCategories(configuration: HermesConfiguration) {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const field of Object.values(configuration.fields)) {
    counts[field.category] = (counts[field.category] ?? 0) + 1;
  }
  const ordered = [
    ...configuration.categoryOrder.filter((category) => counts[category] !== undefined),
    ...Object.keys(counts).filter((category) => !configuration.categoryOrder.includes(category)).sort(),
  ];
  return ordered.map((id) => ({ id, label: titleCase(id), count: counts[id] ?? 0 }));
}

export function matchingConfigurationFields(
  configuration: HermesConfiguration,
  search: string,
  category: string,
) {
  const query = search.trim().toLowerCase();
  return Object.entries(configuration.fields).filter(([path, field]) => {
    if (!query) return field.category === category;
    return `${path} ${field.description} ${field.category}`.toLowerCase().includes(query);
  });
}

export function matchingCredentials(environment: HermesEnvironment, search: string) {
  const query = search.trim().toLowerCase();
  return Object.entries(environment)
    .filter(([key, entry]) => `${key} ${entry.provider_label} ${entry.description}`.toLowerCase().includes(query))
    .sort(([leftKey, left], [rightKey, right]) => {
      if (left.is_set !== right.is_set) return left.is_set ? -1 : 1;
      return leftKey.localeCompare(rightKey);
    });
}

export function parseHermesList(value: string): Array<string | number | boolean> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn("Unexpected Hermes list parsing failure", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  const parsed = HermesConfigValueSchema.safeParse(decoded);
  return parsed.success && Array.isArray(parsed.data) ? parsed.data : null;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isCurrentRequestRevision(activeRevision: number, responseRevision: number): boolean {
  return activeRevision === responseRevision;
}
