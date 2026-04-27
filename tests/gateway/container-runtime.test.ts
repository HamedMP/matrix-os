import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("container runtime image", () => {
  it("copies zsh config into the final image", () => {
    const dockerfile = readFileSync("Dockerfile", "utf-8");

    expect(dockerfile).toContain("COPY distro/zshrc /app/distro/zshrc");
    expect(dockerfile).toContain("COPY distro/p10k.zsh /app/distro/p10k.zsh");
  });

  it("seeds zsh startup files into existing user home volumes", () => {
    const entrypoint = readFileSync("distro/docker-entrypoint.sh", "utf-8");

    expect(entrypoint).toContain('install_shell_config "$MATRIX_HOME"');
    expect(entrypoint).toContain('install_shell_config "/home/matrixos"');
  });

  it("provides a readable zsh prompt without optional theme assets", () => {
    const zshrc = readFileSync("distro/zshrc", "utf-8");

    expect(zshrc).toContain("powerlevel10k.zsh-theme");
    expect(zshrc).toContain("setopt prompt_subst");
    expect(zshrc).toContain("PROMPT='%F{green}${USER:-matrixos}%f %F{blue}%2~%f %# '");
  });
});
