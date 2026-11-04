import type {Hono} from "hono";
import {createHostBundleRoutes} from "./host-bundle-routes.js";
import {createPrivatePreviewUpdateRoutes} from "./private-preview-update-routes.js";
import {createPreviewPairUpdateRoutes} from "./preview-pair/update-routes.js";
/** Keep the complete public bundle/update prefix family ahead of owner routing. */
export function mountHostBundleRoutes(app:Hono<any>,options:Parameters<typeof createHostBundleRoutes>[0]){
 const hostBundleRoutes=createHostBundleRoutes(options);
 app.route("/system-bundles",hostBundleRoutes);
 app.route("/private-preview-updates",createPrivatePreviewUpdateRoutes({db:options.db,hostBundleRoutes,logRouteError:options.logRouteError}));
 app.route("/preview-pair-updates",createPreviewPairUpdateRoutes({db:options.db,hostBundleRoutes,logRouteError:options.logRouteError}));
}
