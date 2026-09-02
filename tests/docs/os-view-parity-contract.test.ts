import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const contributorGuidance = read("AGENTS.md");
const uxGuide = read("specs/ux-guide.md");
const parityAudit = read("docs/pr-evidence/web-desktop-parity/audit.md");
const codingAgentGuide = read("docs/dev/coding-agent-shells.md");
const mobileGuide = read("docs/dev/mobile-shell.md");
const contract = read("specs/119-os-view-parity/spec.md");

const authoritativeDocs = [
  contributorGuidance,
  uxGuide,
  parityAudit,
  codingAgentGuide,
  mobileGuide,
  contract,
].join("\n");

describe("OS-view parity contract", () => {
  it("uses unambiguous surface names and treats OS view as the umbrella term", () => {
    for (const surface of [
      "Web Canvas",
      "Web Desktop",
      "Electron Desktop",
      "Web Mobile",
      "Native Mobile",
    ]) {
      expect(contract).toContain(surface);
    }

    expect(contract).toMatch(/OS view[^\n]+umbrella/i);
    expect(authoritativeDocs).not.toContain("Canvas mode is the primary shell experience");
    expect(authoritativeDocs).not.toContain("The browser shell remains Canvas-first");
    expect(authoritativeDocs).not.toContain("Desktop only; legacy renderer values migrate to Desktop");
    expect(authoritativeDocs).not.toContain("Canvas remains implemented internally but is intentionally not exposed");
  });

  it("defines Desktop defaults and launcher-based Canvas access without losing work", () => {
    expect(contract).toMatch(/Web Desktop[^\n]+default/i);
    expect(contract).toMatch(/Electron Desktop[^\n]+default/i);
    expect(contract).toMatch(/Canvas[^\n]+app launcher/i);
    expect(contract).toMatch(/remembered independently[^\n]+Web[^\n]+Electron/i);
    expect(contract).toMatch(/switch[^\n]+without losing[^\n]+open apps/i);
  });

  it("requires one shared state model and owner-controlled database persistence", () => {
    expect(contract).toMatch(/owner-controlled Postgres/i);
    expect(contract).toMatch(/logical coordinates/i);
    expect(contract).toMatch(/viewport[^\n]+clamp/i);
    expect(contract).toMatch(/Web Desktop[^\n]+Electron Desktop[^\n]+same logical/i);
    expect(contract).toMatch(/Canvas[^\n]+pan[^\n]+zoom/i);
    expect(contract).toMatch(/Chat[^\n]+Settings[^\n]+Terminal[^\n]+Files/i);
    expect(contract).toMatch(/multiple related records[^\n]+one transaction/i);
    expect(contract).toMatch(/Revision checks[^\n]+write statement/i);
    expect(contract).toMatch(/Retried requests[^\n]+idempotent/i);
    expect(contract).toMatch(/REST mutations[^\n]+notify subscribers[^\n]+after commit/i);
    expect(contract).toMatch(/reconnect[^\n]+latest revision[^\n]+stale local geometry/i);
  });

  it("retires Workspace Canvas without deleting owner data", () => {
    expect(contract).toMatch(/Workspace Canvas[^\n]+retired/i);
    expect(contract).toMatch(/must not delete[^\n]+owner data/i);
    expect(contract).not.toMatch(/canonical built-ins[^\n]+Workspace/i);
  });

  it("requires a five-surface PR matrix and real evidence", () => {
    for (const row of [
      "| Web Canvas |",
      "| Web Desktop |",
      "| Electron Desktop |",
      "| Web Mobile |",
      "| Native Mobile |",
    ]) {
      expect(contributorGuidance).toContain(row);
      expect(contract).toContain(row);
    }

    expect(contract).toMatch(/N\/A[^\n]+architectural rationale[^\n]+reviewer approval/i);
    expect(contract).toMatch(/Web Desktop screenshot[^\n]+never[^\n]+Electron Desktop evidence/i);
    expect(contract).toMatch(/Web Mobile[^\n]+never[^\n]+Native Mobile evidence/i);
  });

  it("records the visual authority transition and shared-component rule", () => {
    expect(contract).toMatch(/Figma[^\n]+initial visual baseline/i);
    expect(contract).toMatch(/Electron Desktop[^\n]+ongoing[^\n]+ground truth/i);
    expect(contract).toMatch(/shared component/i);
    expect(contract).toMatch(/Support Chat[^\n]+Finder[^\n]+computer switcher/i);
  });
});
