import { defineCommand } from "citty";

const COMMANDS = [
  "login",
  "logout",
  "sync",
  "peers",
  "keys",
  "ssh",
  "shell",
  "sh",
  "profile",
  "whoami",
  "status",
  "doctor",
  "instance",
  "completion",
];

export const completionCommand = defineCommand({
  meta: { name: "completion", description: "Print shell completion command names" },
  run: () => {
    console.log(COMMANDS.join("\n"));
  },
});
