import { describe, expect, it } from "vitest";
import { REDACTED_SECRET, redactSecrets, scanAppFiles } from "../../packages/contracts/src/app-store-scan";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]));

const rules = (report: ReturnType<typeof scanAppFiles>) => report.findings.map(f => f.rule);

// Fixtures are assembled at runtime so the repository itself never contains secret-shaped literals.
const k = (...parts: string[]) => parts.join("");
const SECRETS = {
  anthropic: k("sk-", "ant-", "api03-", "A".repeat(40)),
  openai: k("sk-", "proj-", "B".repeat(40)),
  aws: k("AKIA", "ABCDEFGHIJKLMNOP"),
  github: k("ghp_", "C".repeat(36)),
  stripe: k("sk_", "live_", "D".repeat(24)),
  slack: k("xoxb-", "1234567890-", "abcdefghij"),
  google: k("AIza", "E".repeat(35)),
  jwt: k("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTYifQ", ".", "c2lnbmF0dXJlLXZhbHVl"),
  pem: k("-----BEGIN ", "PRIVATE KEY-----"),
};

describe("scanAppFiles", () => {
  it.each(Object.entries(SECRETS))("flags %s secrets as high severity without echoing them", (_name, secret) => {
    const report = scanAppFiles(files({ "src/config.ts": `export const value = "${secret}";` }));
    expect(report.blocking).toBe(true);
    expect(report.findings[0]).toMatchObject({ category: "secret", severity: "high", file: "src/config.ts", line: 1 });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("flags high-entropy generic assignments but not placeholders", () => {
    const hit = scanAppFiles(files({ "src/a.ts": `const apiKey = "${k("q8Zr", "T2vLp9", "Xw4Mn7Ks")}";` }));
    expect(rules(hit)).toContain("secret.generic");
    const miss = scanAppFiles(files({ "src/a.ts": 'const apiKey = "YOUR_API_KEY_HERE_PLEASE";\nconst token = settings.token;' }));
    expect(rules(miss)).not.toContain("secret.generic");
  });

  it("flags owner identity terms as high and other emails as medium", () => {
    const report = scanAppFiles(
      files({ "src/App.tsx": 'const me = "Alice Example";\nconst mail = "alice@corp.com";\nconst other = "bob@foo.org";\nconst demo = "demo@example.com";' }),
      { ownerTerms: ["Alice Example", "alice@corp.com", "alice"] },
    );
    const byLine = Object.fromEntries(report.findings.map(f => [`${f.rule}:${f.line}`, f.severity]));
    expect(byLine["personal.owner:1"]).toBe("high");
    expect(byLine["personal.owner:2"]).toBe("high");
    expect(byLine["personal.email:3"]).toBe("medium");
    expect(Object.keys(byLine).some(key => key.endsWith(":4"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("alice@corp.com");
  });

  it("ignores owner terms shorter than three characters", () => {
    const report = scanAppFiles(files({ "src/a.ts": "const al = 1;" }), { ownerTerms: ["al"] });
    expect(report.findings).toEqual([]);
  });

  it("flags phone numbers, home paths, account labels and analytics ids", () => {
    const report = scanAppFiles(files({
      "src/a.ts": [
        'const phone = "+1 (415) 555-0134";',
        'const file = "/home/matrix/home/apps/x/data.json";',
        'await window.MatrixOS.service("gmail", "list_messages", { q: "is:unread" }, "Work - Finna");',
        'const ga = "G-ABCDEFGH12";',
        'const mac = "/Users/alice/notes.md";',
      ].join("\n"),
    }));
    expect(rules(report)).toEqual(expect.arrayContaining([
      "personal.phone", "owner_config.home_path", "owner_config.account_label", "owner_config.analytics_id",
    ]));
    expect(report.findings.filter(f => f.rule === "owner_config.home_path").map(f => f.line)).toEqual([2, 5]);
  });

  it("does not flag service calls without a fixed label", () => {
    const report = scanAppFiles(files({ "src/a.ts": 'await window.MatrixOS.service("gmail", "list_messages", { q: "x" }, selectedLabel);' }));
    expect(rules(report)).not.toContain("owner_config.account_label");
  });

  it("flags unsafe code patterns", () => {
    const report = scanAppFiles(files({
      "src/a.ts": [
        "localStorage.setItem('x', '1');",
        "eval(code);",
        "const f = new Function('return 1');",
        "fetch('/api/bridge/query');",
        "window.parent.postMessage({}, '*');",
        "document.cookie = 'a=b';",
        "import shared from '../../_shared/theme';",
        "importScripts('x.js');",
      ].join("\n"),
    }));
    expect(rules(report)).toEqual(expect.arrayContaining([
      "unsafe_code.storage", "unsafe_code.eval", "unsafe_code.raw_api", "unsafe_code.parent_frame",
      "unsafe_code.cookie", "unsafe_code.outside_import", "unsafe_code.import_scripts",
    ]));
    expect(report.findings.find(f => f.rule === "unsafe_code.storage")?.severity).toBe("medium");
  });

  it("allows relative imports that stay inside the app", () => {
    const report = scanAppFiles(files({ "src/components/Card.tsx": "import { x } from '../lib/x';\nimport y from './y';" }));
    expect(report.findings).toEqual([]);
  });

  it("skips binary files and lockfiles", () => {
    const report = scanAppFiles(new Map([
      ["public/logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01])],
      ["pnpm-lock.yaml", Buffer.from(`integrity: sha512-${"Z".repeat(80)}\nemail: someone@corp.com`)],
    ]));
    expect(report.findings).toEqual([]);
  });

  it("caps findings and marks truncation", () => {
    const body = Array.from({ length: 600 }, (_, i) => `const e${i} = "user${i}@corp.com";`).join("\n");
    const report = scanAppFiles(files({ "src/a.ts": body }));
    expect(report.findings).toHaveLength(500);
    expect(report.truncated).toBe(true);
    expect(report.blocking).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces secrets and counts replacements", () => {
    const input = `const a = "${SECRETS.anthropic}";\nconst b = "${SECRETS.github}";\nconst c = 1;`;
    const { text, count } = redactSecrets(input);
    expect(count).toBe(2);
    expect(text).not.toContain(SECRETS.anthropic);
    expect(text).toContain(REDACTED_SECRET);
    expect(text).toContain("const c = 1;");
  });

  it("redacts generic high-entropy assignment values only", () => {
    const value = k("q8Zr", "T2vLp9", "Xw4Mn7Ks");
    const { text } = redactSecrets(`const apiKey = "${value}";`);
    expect(text).toBe(`const apiKey = "${REDACTED_SECRET}";`);
  });
});
