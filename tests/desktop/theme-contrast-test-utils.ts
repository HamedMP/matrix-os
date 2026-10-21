import { expect } from 'vitest';

export function resolvedStyleColor(style: string, variables: Record<string, string>): string {
  const name = style.match(/^var\((--[\w-]+)\)$/)?.[1];
  const color = name ? variables[name] : undefined;
  expect(color, `Missing or invalid colour for ${style}`).toMatch(/^#[\da-f]{6}$/i);
  return color!;
}
