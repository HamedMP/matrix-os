import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("legacy shell ChatPopover removal", () => {
  it("does not mount or expose the duplicate chat overlay", () => {
    const desktopSource = readFileSync(
      join(root, "shell/src/components/Desktop.tsx"),
      "utf8",
    );

    expect(desktopSource).not.toContain("ChatPopover");
    expect(desktopSource).not.toContain("chatOpen");
    expect(desktopSource).not.toContain("setChatOpen");
    expect(desktopSource).not.toContain('data-testid="dock-chat"');
    expect(desktopSource).not.toContain('data-testid="dock-chat-mobile"');
  });

  it("removes the overlay component and its dedicated persistence helper", () => {
    expect(existsSync(join(root, "shell/src/components/ChatPopover.tsx"))).toBe(false);
    expect(existsSync(join(root, "shell/src/lib/chat-popover-position.ts"))).toBe(false);
  });
});
