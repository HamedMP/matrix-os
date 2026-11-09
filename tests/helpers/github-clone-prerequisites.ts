/** Offline subprocess results for the owner's GitHub SSH readiness probe. */
export function githubClonePrerequisiteResult(
  command: string,
  args: string[],
  { protocol = "ssh", sshUser = "octocat" }: { protocol?: string; sshUser?: string | null } = {},
): { stdout: string; stderr: string } {
  if (command === "gh" && args[0] === "config") return { stdout: protocol, stderr: "" };
  if (command === "gh" && args[0] === "api") return { stdout: "octocat", stderr: "" };
  if (command === "ssh") {
    if (!sshUser) throw Object.assign(new Error("Permission denied"), { code: 255 });
    throw Object.assign(new Error("SSH greeting"), {
      code: 1,
      stderr: `Hi ${sshUser}! You've successfully authenticated, but GitHub does not provide shell access.\n`,
    });
  }
  if (command === "git" && args[0] === "config") throw Object.assign(new Error("Identity missing"), { code: 1 });
  return { stdout: "", stderr: "" };
}
