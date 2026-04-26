import { defineCommand } from "citty";

export const profileCommand = defineCommand({
  meta: {
    name: "profile",
    description: "Manage Matrix OS CLI profiles",
  },
  run: () => {
    console.log("Profile commands are not implemented yet.");
  },
});
