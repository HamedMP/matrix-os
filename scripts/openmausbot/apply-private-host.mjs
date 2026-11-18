import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pairingListener = `
// Matrix Private Preview commissioning stays on a separate Unix socket whose
// parent directory is private to this daemon. Its normal HTTP socket still
// uses upstream's remote authentication and one-time pairing exchange.
const matrixPairSocket = process.env.OMB_MATRIX_PAIR_SOCKET;
let matrixPairingListener: ReturnType<typeof createServer> | null = null;
if (matrixPairSocket) {
  const pairSocket = matrixPairSocket;
  if (!TUNNEL_SOCKET || dirname(dirname(pairSocket)) !== dirname(TUNNEL_SOCKET)) {
    throw new Error("Invalid Matrix pairing socket configuration");
  }
  mkdirSync(dirname(pairSocket), { mode: 0o700, recursive: true });
  chmodSync(dirname(pairSocket), 0o700);
  rmSync(pairSocket, { force: true });
  // Like the upstream CLI owner proof, this comes from stdin and is never
  // inherited by Bot processes in the environment or written in their volume.
  let proof = "";
  let expectedProof: Buffer | undefined;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    proof += chunk;
    if (proof.length <= 65 && !proof.includes("\\n")) return;
    if (/^[a-f0-9]{64}\\n$/.test(proof)) expectedProof = Buffer.from(proof.trim());
    proof = "";
    process.stdin.destroy();
  });
  let outstandingPairing: string | undefined;
  matrixPairingListener = createServer({ headersTimeout: 5_000, requestTimeout: 5_000 }, (req, res) => {
    if (req.method !== "POST" || req.url !== "/pairing") return json(res, 404, { error: "Not found" });
    const presented = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
    if (!expectedProof || !presented || !matrixTimingSafeEqual(expectedProof, Buffer.from(presented[1]!))) {
      return json(res, 403, { error: "Forbidden" });
    }
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0) {
      return json(res, 400, { error: "A body is not accepted" });
    }
    if (outstandingPairing) sessions.cancelPairing(outstandingPairing);
    const opened = sessions.openPairing({ label: "Matrix Private Preview", ttlMs: 5 * 60_000 });
    outstandingPairing = opened.id;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { code: formatPairingCode(opened.code), expiresAt: opened.expiresAt });
  });
  matrixPairingListener.listen(pairSocket, () => chmodSync(pairSocket, 0o600));
}
`;

function replacePinned(source, match, replacement) {
  const first = source.indexOf(match);
  if (first < 0 || source.indexOf(match, first + match.length) >= 0) {
    throw new Error(`Expected one pinned source anchor: ${match}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + match.length);
}

export function patchPrivateHost(source) {
  let patched = replacePinned(source, 'import { existsSync, realpathSync, rmSync } from "node:fs";',
    'import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";\nimport { timingSafeEqual as matrixTimingSafeEqual } from "node:crypto";');
  patched = replacePinned(patched, 'import { basename, join } from "node:path";',
    'import { basename, dirname, join } from "node:path";');
  patched = replacePinned(patched, 'if (HOSTED_WORKSPACE) setDefaultApprovalMode("ask");',
    'if (HOSTED_WORKSPACE || process.env.OMB_MATRIX_PAIR_SOCKET) setDefaultApprovalMode("ask");');
  const customMcpAnchor = '        const custom = await mcpServersHost.prepare(bot).then(() => teamConnections.turnMcp(bot, threadId, dispatchClaimId));';
  patched = replacePinned(patched, customMcpAnchor, `${customMcpAnchor}
        // Mount for direct paired-user turns only. The Matrix broker still
        // requires a fresh owner decision for every read, even if called directly.
        if (process.env.OMB_MATRIX_DRIVE_MCP === "1" && personLine && !opts?.unattended
          && !opts?.app && !userMessage.relayed && opts?.trigger?.kind === "user") {
          custom["matrix-drive-preview"] = {
            command: "/usr/local/bin/node", args: ["/opt/openmausbot/matrix-drive-mcp.mjs"], env: {},
          };
        }`);
  const tunnelAnchor = [
    '    console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);',
    '  });',
    '}',
  ].join("\n");
  patched = replacePinned(patched, tunnelAnchor, tunnelAnchor + "\n" + pairingListener);
  return replacePinned(patched, "      tunnelListener?.close(); stopCloudHomeConnectedApps();",
    "      tunnelListener?.close(); matrixPairingListener?.close(); stopCloudHomeConnectedApps();");
}

export function patchMatrixProviderRegistry(source) {
  let patched = replacePinned(source, 'import { basename, join } from "node:path";',
    'import { basename, join } from "node:path";\nimport { MATRIX_HOSTED_INSTANCE, matrixHostedDriver, matrixHostedProviderConfigs, runMatrixHostedModelTurn, takeMatrixHostedOwnerSend, type MatrixHostedTurnTicket } from "./drivers/matrix-provider.ts";');
  patched = replacePinned(patched, "const providerConfigs = () => hostedModels ? hostedModels.configs() : instanceConfigs(cfg);",
    "const providerConfigs = () => matrixHostedProviderConfigs(hostedModels ? hostedModels.configs() : instanceConfigs(cfg));");
  patched = replacePinned(patched, 'const registry = new ProviderRegistry(BUILT_IN_DRIVERS, { statusFile:',
    'const registry = new ProviderRegistry(process.env.OMB_MATRIX_PAIR_SOCKET ? [...BUILT_IN_DRIVERS, matrixHostedDriver] : BUILT_IN_DRIVERS, { statusFile:');
  const direct = "  const message = await startTurn(botId, text, { threadId, replyTo, sendId, sender, trigger, via, callId, dataContext, app, mentions, allowRoomTurnElsewhere: true });";
  patched = replacePinned(patched, direct, direct.replace("allowRoomTurnElsewhere: true", "allowRoomTurnElsewhere: true, matrixHostedTurn: takeMatrixHostedOwnerSend(botId, threadId, sendId)"));
  patched = replacePinned(patched, "    requestMessageId?: string;\n    origin?: WorkOrigin;", "    requestMessageId?: string;\n    matrixHostedTurn?: MatrixHostedTurnTicket;\n    origin?: WorkOrigin;");
  const turnDispatch = '(input) => quickFallback.sendTurn(instance, input, route.quickModel ? { model, own: bot.modelSelection, onFallback: () => store.patchMessage(threadId, userMessage.id, { quickModel: undefined }) } : undefined)';
  patched = replacePinned(patched, turnDispatch,
    '(input) => runMatrixHostedModelTurn(instance.instanceId, opts?.matrixHostedTurn, () => ' + turnDispatch.slice('(input) => '.length) + ')');
  const readOnly = '    if (hostedModels) return { ...described, readOnly: true,';
  return replacePinned(patched, readOnly, readOnly.replace('hostedModels', 'hostedModels || instance.instanceId === MATRIX_HOSTED_INSTANCE'));
}

export function patchMatrixProviderDispatch(source) {
  let patched = replacePinned(source, 'import { z } from "zod";',
    'import { z } from "zod";\nimport { withMatrixHostedOwnerSend } from "../drivers/matrix-provider.ts";');
  patched = replacePinned(patched, "        const receipt = await acceptDirectSend({", "        const dispatch = () => acceptDirectSend({");
  return replacePinned(patched, "        }, guardedStart);", `        }, guardedStart);
        let receipt: DirectSendReceipt;
        if (!guarded && !press && !appSent && !pointed && !pageOpen && !followUp && auth.kind === "session" && sendId) {
          receipt = await withMatrixHostedOwnerSend(req.headers["x-matrix-hosted-bots-model-turn"], { botId: bot.id, threadId, sendId }, dispatch);
        } else {
          receipt = await dispatch();
        }`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: apply-private-host.mjs <upstream source directory>");
  const file = resolve(process.argv[2], "server/index.ts");
  const route = resolve(process.argv[2], "server/routes/bot-messages.ts");
  await writeFile(file, patchPrivateHost(patchMatrixProviderRegistry(await readFile(file, "utf8"))));
  await writeFile(route, patchMatrixProviderDispatch(await readFile(route, "utf8")));
  await copyFile(new URL("./matrix-provider.ts", import.meta.url), resolve(process.argv[2], "server/drivers/matrix-provider.ts"));
}
