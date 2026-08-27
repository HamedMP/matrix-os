import { createElement, type ComponentType, type SVGProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect } from "vitest";

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number;
}>;

function normalizedGeometry(svg: Element): string {
  const clone = svg.cloneNode(true) as Element;
  for (const element of [clone, ...clone.querySelectorAll("*")]) {
    element.removeAttribute("stroke-width");
  }
  return clone.innerHTML;
}

function renderedIconGeometry(Icon: IconComponent): string {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(Icon, { size: 24 }));
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("Expected icon component to render an SVG");
  return normalizedGeometry(svg);
}

export function expectRenderedIcon(
  actual: Element | null | undefined,
  ExpectedIcon: IconComponent,
): void {
  expect(actual, "Expected an SVG icon").toBeTruthy();
  expect(actual?.tagName.toLowerCase()).toBe("svg");
  expect(actual ? normalizedGeometry(actual) : null).toBe(renderedIconGeometry(ExpectedIcon));
}
