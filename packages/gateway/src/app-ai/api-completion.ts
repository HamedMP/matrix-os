import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { AppAiResultSchema, type AppAiResult, type AppAiRouteSelection } from "@matrix-os/contracts";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import { readOwnerAnthropicKey } from "../ai-providers/owner-anthropic-key.js";
const MAX_RESPONSE_BYTES = 256000;
const AnthropicResult = z.object({ stop_reason: z.literal("end_turn"), content: z.array(z.object({ type: z.literal("text"), text: z.string().max(64000) })).max(32) });
const OpenAiResult = z.object({ choices: z.array(z.object({ finish_reason: z.literal("stop"), message: z.object({ content: z.string().max(64000), tool_calls: z.array(z.never()).max(0).optional() }) })).length(1) });
async function readResult(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body)
        throw new Error("App AI response unavailable");
    const reader = response.body.getReader();
    let size = 0;
    let chunksRead = 0;
    const chunks: Uint8Array[] = [];
    let cancellation: Promise<void> | undefined;
    let terminalReadFailure = false;
    const cancel = () => cancellation ??= reader.cancel();
    const abort = () => { void cancel().catch(error => console.warn("[app-ai] cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await reader.read(); }
            catch (error) { terminalReadFailure = true; throw error; }
            if (next.done)
                break;
            size += next.value.byteLength;
            chunksRead++;
            if (size > MAX_RESPONSE_BYTES || chunksRead > 16384) {
                await cancel();
                throw new Error("App AI response too large");
            }
            if (next.value.byteLength) chunks.push(next.value);
        }
        signal.throwIfAborted();
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    }
    catch (error) {
        // A rejected read is terminal; its stored error is not an uncertain
        // live cancellation. Late headers still require actual body disposal.
        if (!terminalReadFailure) await cancel();
        throw error;
    }
    finally {
        signal.removeEventListener("abort", abort);
        try { await cancellation; }
        finally { reader.releaseLock(); }
    }
}
/** Only text messages are sent. The existing relay owns budget holds and exact usage settlement. */
export async function generateApiAppText(options: {
    homePath: string;
    route: AppAiRouteSelection;
    prompt: string;
    signal: AbortSignal;
    revalidate: () => Promise<boolean>;
    fundedCredentialProvider?: MatrixFundedCredentialProvider;
    fundedAdmission?: FundedAdmissionQueue;
    fetchImpl?: typeof fetch;
}): Promise<AppAiResult> {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30000)]);
    signal.throwIfAborted();
    const funded = options.route.accessSourceId === "matrix_cloudflare" || options.route.accessSourceId === "matrix_included";
    const anthropic = options.route.accessSourceId !== "matrix_cloudflare";
    const headers = new Headers({ "content-type": "application/json", "accept": "application/json" });
    let base = "https://api.anthropic.com";
    if (funded) {
        if (!options.fundedCredentialProvider?.enabled)
            throw new Error("App AI funded access unavailable");
        const lease = await options.fundedCredentialProvider.getCredential({ requestClass: "interactive", signal });
        if (!lease.token || !lease.relayBaseUrl)
            throw new Error("App AI funded access unavailable");
        base = lease.relayBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
        headers.set("authorization", `Bearer ${lease.token}`);
        headers.set("x-matrix-funded-claim-key", `app-${randomUUID()}`);
    }
    else {
        if (options.route.accessSourceId !== "owner_anthropic_key")
            throw new Error("App AI source unavailable");
        const key = await readOwnerAnthropicKey(options.homePath);
        if (key.state !== "unverified" || !key.key)
            throw new Error("App AI credentials unavailable");
        headers.set("x-api-key", key.key);
    }
    const system = "Answer using only the supplied text. You have no tools or access to files.";
    const body = anthropic ? { model: options.route.modelId, max_tokens: 8192, stream: false, system, messages: [{ role: "user", content: options.prompt }] } :
        { model: options.route.modelId, max_tokens: 8192, stream: false, tool_choice: "none", store: false, messages: [{ role: "system", content: system }, { role: "user", content: options.prompt }] };
    if (anthropic)
        headers.set("anthropic-version", "2023-06-01");
    const send = async () => {
        signal.throwIfAborted();
        if (!await options.revalidate())
            throw new Error("App AI access revoked");
        signal.throwIfAborted();
        return (options.fetchImpl ?? fetch)(`${base}/v1/${anthropic ? "messages" : "chat/completions"}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
    };
    const response = funded && options.fundedAdmission ? await options.fundedAdmission.run<Response>({ requestClass: "interactive", signal }, async () => {
        const result = await send();
        if (result.status === 429 && result.headers.has("x-matrix-funded-reason")) {
            await result.body?.cancel();
            return { kind: "busy" };
        }
        return { kind: "done", value: result };
    }) : await send();
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error("App AI request failed");
    }
    const payload = await readResult(response, signal);
    if (!await options.revalidate())
        throw new Error("App AI access revoked");
    const text = anthropic ? AnthropicResult.parse(payload).content.map(part => part.text).join("") : OpenAiResult.parse(payload).choices[0]!.message.content;
    return AppAiResultSchema.parse({ text });
}
