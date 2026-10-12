import { readFileSync } from "node:fs";
import { join } from "node:path";

import { colors } from "../lib/theme";

// The redesign is black, white and grey. Green stays only where the design
// draws it: status dots, finished steps, the text cursor and the mascots.
const GREEN = /palette\.(green|teal)\b|colors\.(brand|brandStrong|accentSurface)\b|appColors\.(soft|green)\b|colors(\.light)?\.(primary|forest|moss|lichen)\b|228, 232, 222|#465243/g;

const GREEN_FREE = [
  "app/(drawer)/(tabs)/terminal.tsx",
  "app/integrations-installed/index.tsx",
  "app/(drawer)/(tabs)/(chats)/shared.tsx",
  "app/index.tsx",
  "app/_layout.tsx",
  "components/JourneyGate.tsx",
  "components/AppRuntimeFrame.tsx",
  "components/TerminalControlBar.tsx",
  "components/auth/EmailCodeForm.tsx",
  "components/auth/GatewayUrlPanel.tsx",
  "components/auth/SelfHostedSignInPanel.tsx",
  "components/collaboration/SessionAccessControl.tsx",
  "components/collaboration/SessionDiscussionSheet.tsx",
  "components/collaboration/SharedChatComposer.tsx",
  "components/collaboration/SharedTerminalScreen.tsx",
  "components/files/FileCreationControls.tsx",
  "components/integrations/IntegrationLogo.tsx",
  "components/terminal/TerminalAgentLogo.tsx",
  "components/ui/FloatingActionButton.tsx",
];

function source(path: string): string {
  return readFileSync(join(__dirname, "..", path), "utf8");
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

describe("green left over from the old design", () => {
  it.each(GREEN_FREE)("%s uses no green colour", (path) => {
    expect(source(path).match(GREEN) ?? []).toEqual([]);
  });

  it("keeps green in App settings only for the switches", () => {
    const matches = source("app/settings-detail/app-settings.tsx").match(GREEN) ?? [];
    expect(matches).toEqual(["appColors.green", "appColors.green"]);
    expect(source("app/settings-detail/app-settings.tsx").match(/trackColor=.*appColors\.green/g)).toHaveLength(2);
  });

  it("draws the terminal console in neutral greys", () => {
    const palette = colors.terminal;
    const greys = ["bg", "surface", "fg", "fgDim", "cursor", "black", "white", "brightBlack", "brightWhite"] as const;
    // A grey has (nearly) equal red, green and blue.
    const tinted = greys.filter((name) => {
      const [red, green, blue] = channels(palette[name]);
      return Math.max(red, green, blue) - Math.min(red, green, blue) > 4;
    });
    expect(tinted).toEqual([]);
    expect(palette.selection).toBe("rgba(200, 198, 198, 0.30)");
    expect(palette.border).toBe("rgba(225, 224, 224, 0.08)");
  });

  it("leaves the colours programs print with as they were", () => {
    expect(colors.terminal).toMatchObject({
      red: "#E06A4E", green: "#7FC58D", yellow: "#D9B45A", blue: "#83A8DB", magenta: "#C29BD4", cyan: "#6FCFC4",
      brightRed: "#F08368", brightGreen: "#9FD8AC", brightYellow: "#E8C778", brightBlue: "#9CBEEC",
      brightMagenta: "#D6B6E4", brightCyan: "#8BE0D6",
    });
  });
});
