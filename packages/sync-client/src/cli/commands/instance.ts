import { defineCommand } from "citty";

export const instanceCommand = defineCommand({
  meta: {
    name: "instance",
    description: "Manage the active Matrix OS instance",
  },
  run: () => {
    console.log("Instance commands are not implemented yet.");
  },
});
