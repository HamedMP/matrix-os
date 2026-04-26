import { defineCommand } from "citty";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose Matrix OS CLI and shell issues",
  },
  run: () => {
    console.log("Doctor checks are not implemented yet.");
  },
});
