// Imported first by the main entry so the guard is in place before any other
// module can log. See stdio-guard.ts.
import { installBrokenPipeGuard } from "./stdio-guard";

installBrokenPipeGuard([process.stdout, process.stderr]);
