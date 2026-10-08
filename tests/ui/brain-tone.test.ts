import { resolve } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";
import { BRAIN_TONE } from "../../packages/ui/src/brain/brain-tone.js";

const root = resolve(__dirname, "../..");

type Declarations = Record<string, string>;

/** Builds the classes with the Tailwind version both renderers use, flattened to plain rules. */
async function compiledRules(classes: string): Promise<{ selector: string; declarations: Declarations }[]> {
  const tailwind = await compile('@import "tailwindcss/utilities.css";', { base: root, onDependency() {} });
  const css = optimize(tailwind.build(classes.split(/\s+/))).code;
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({
      selector: selector.trim(),
      declarations: Object.fromEntries(
        body.split(";").map((line) => line.split(/:(.*)/).map((part) => part.trim()))
          .filter(([name, value]) => name && value),
      ) as Declarations,
    }))
    .filter(({ selector }) => selector.startsWith("."));
}

/** The outline a Web element with these classes gets, with no global focus rule (Web has none). */
function outline(rules: { selector: string; declarations: Declarations }[], focused: boolean) {
  // The registered initial value of Tailwind's outline style variable.
  const style: Declarations = { "--tw-outline-style": "solid" };
  // A :focus-visible rule outranks a plain class rule, so it applies last.
  const onFocus = (rule: { selector: string }) => rule.selector.endsWith(":focus-visible");
  for (const rule of rules.filter((rule) => !onFocus(rule))) Object.assign(style, rule.declarations);
  if (focused) for (const rule of rules.filter(onFocus)) Object.assign(style, rule.declarations);
  const read = (value: string | undefined) => value?.replace(/var\((--[\w-]+)\)/g, (_, name: string) => style[name] ?? "");
  return { style: read(style["outline-style"]), width: style["outline-width"], color: style["outline-color"] };
}

describe("BRAIN_TONE.focus", () => {
  it("draws a solid 2px ring-colored outline on keyboard focus and none otherwise", async () => {
    const rules = await compiledRules(BRAIN_TONE.focus);

    expect(outline(rules, false).style).toBe("none");
    expect(outline(rules, true)).toEqual({ style: "solid", width: "2px", color: "var(--ring, var(--accent))" });
  });

  it("sets the outline style back on focus whenever it clears the outline", () => {
    const classes = BRAIN_TONE.focus.split(/\s+/);
    const clears = classes.some((name) => name === "outline-none" || name === "outline-hidden");
    const restores = classes.some((name) => /^focus-visible:outline-(solid|dashed|dotted|double)$/.test(name));

    expect(clears && !restores).toBe(false);
  });
});
