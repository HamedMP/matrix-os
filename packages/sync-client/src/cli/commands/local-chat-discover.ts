import { defineCommand } from "citty";
import { discoverLocalChatFiles } from "../../import/discovery.js";
import { expandLocalPath } from "../file-transfer-client.js";
import { formatCliError, formatCliSuccess } from "../output.js";
export const localChatDiscoverCommand = defineCommand({ meta: { name: "discover", description: "List Codex and Claude transcript metadata without uploading or reading message previews" }, args: { project: { type: "string", required: false, description: "Existing local Git repository to match using recorded evidence" }, json: { type: "boolean", default: false } }, run: async ({ args }) => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        try {
            const result = await discoverLocalChatFiles({ ...(typeof args.project === "string" ? { project: expandLocalPath(args.project) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60000)]) });
            if(!args.json&&result.issues.length)console.error(`${result.issues.length} transcript files were unavailable or unsupported; inspect --json for paths and issue codes.`);
        console.log(args.json ? formatCliSuccess(result) : result.files.map(file => `${file.harness}\t${file.sourceKind}\t${file.association}\t${file.rawBytes}\t${file.path}`).join("\n") || "No supported local transcript files found.");
        }
        catch (error: unknown) {
            console.warn("[chat/discover] inventory failed", error instanceof Error ? error.name : "UnknownError");
            const message = "Transcript discovery failed. Check the selected roots and repository, then retry.";
            console.error(args.json ? formatCliError("chat_discovery_failed", message) : message);
            process.exitCode = controller.signal.aborted ? 130 : 1;
        }
        finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
        }
    } });
