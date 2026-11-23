// The installer is bundled from the repository's scripts/install.sh at deploy
// time, so the host serves exactly the reviewed script of the deployed commit.
import installScript from "../../../scripts/install.sh";
import { createInstallerHandler } from "./handler.js";

export default {
  fetch: createInstallerHandler(installScript),
};
