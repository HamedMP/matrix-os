import { createRequire, syncBuiltinESMExports } from "node:module";
const processModule = createRequire(import.meta.url)("node:child_process");
const original = processModule.spawn;
processModule.spawn = (command, args, options) => {
  if (args.includes("app-server")) {
    process.stderr.write("Injected spawn EAGAIN\n");
    throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
