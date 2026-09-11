import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildAgentSdkTransportEnvironment,
  inspectAgentSdkInstallation,
} from "./verification.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const MCP_TOOL_NAME = "mcp__spike__echo";

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startMessage(response, contentBlock) {
  response.write(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    }),
  );
  response.write(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: contentBlock,
    }),
  );
}

function finishMessage(response, stopReason) {
  response.write(
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  );
  response.write(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
  );
  response.end(sseEvent("message_stop", { type: "message_stop" }));
}

function sendText(response, text, stopReason = "end_turn") {
  startMessage(response, { type: "text", text: "" });
  response.write(
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
  );
  finishMessage(response, stopReason);
}

function sendToolUse(response) {
  startMessage(response, {
    type: "tool_use",
    id: "toolu_spike_echo",
    name: MCP_TOOL_NAME,
    input: {},
  });
  response.write(
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"value":"first-turn"}' },
    }),
  );
  finishMessage(response, "tool_use");
}

function sendAgentToolUse(response) {
  startMessage(response, {
    type: "tool_use",
    id: "toolu_spike_agent",
    name: "Agent",
    input: {},
  });
  response.write(
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          description: "Run deterministic child",
          prompt: "Subagent child verification: reply subagent-child-ok.",
          subagent_type: "spike-agent",
        }),
      },
    }),
  );
  finishMessage(response, "tool_use");
}

function requestHasText(body, text) {
  return body.messages?.some((message) =>
    Array.isArray(message.content)
      ? message.content.some(
          (block) =>
            block?.type === "text" &&
            typeof block.text === "string" &&
            block.text.includes(text),
        )
      : false,
  );
}

function requestHasToolResult(body) {
  return body.messages?.some((message) =>
    Array.isArray(message.content)
      ? message.content.some((block) => block?.type === "tool_result")
      : false,
  );
}

function requestHasResumePrompt(body) {
  return requestHasText(body, "Resume verification");
}

function requestHasCancellationPrompt(body) {
  return requestHasText(body, "Cancellation verification");
}

async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake provider did not bind a TCP port");
  }
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function resultMessage(messages) {
  const result = messages.findLast((message) => message.type === "result");
  if (!result || result.subtype !== "success" || result.is_error) {
    throw new Error("Agent SDK fake-provider turn did not succeed");
  }
  return result;
}

function initMessage(messages) {
  const init = messages.find(
    (message) => message.type === "system" && message.subtype === "init",
  );
  if (!init) throw new Error("Agent SDK fake-provider turn emitted no init event");
  return init;
}

export async function runFakeProviderVerification({ sdkPackageDirectory }) {
  const artifactReport = await inspectAgentSdkInstallation(sdkPackageDirectory);
  const runtime = await import(
    pathToFileURL(path.join(sdkPackageDirectory, "sdk.mjs")).href
  );
  const requireFromSpike = createRequire(import.meta.url);
  const { z } = requireFromSpike("zod/v4");
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "matrix-agent-sdk-spike-"));
  const configDirectory = path.join(workDirectory, "claude-config");
  const requests = [];
  let hookCalls = 0;
  let mcpCalls = 0;
  let markCancellationRequestSeen;
  const cancellationRequestSeen = new Promise((resolve) => {
    markCancellationRequestSeen = resolve;
  });

  await mkdir(path.join(workDirectory, ".claude", "skills", "spike-skill"), {
    recursive: true,
  });
  await writeFile(
    path.join(workDirectory, ".claude", "skills", "spike-skill", "SKILL.md"),
    "---\nname: spike-skill\ndescription: Phase 0 SDK verification fixture\n---\nReply deterministically.\n",
    { flag: "wx" },
  );

  const server = http.createServer(async (request, response) => {
    if (request.method === "HEAD" && request.url === "/api/hello") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }

    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    const body = JSON.parse(rawBody);
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      anthropicBeta: request.headers["anthropic-beta"],
      body,
    });

    if (requestHasCancellationPrompt(body)) {
      markCancellationRequestSeen();
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    if (requestHasText(body, "Refusal verification")) {
      sendText(response, "refused-by-spike", "refusal");
    } else if (requestHasText(body, "Subagent child verification")) {
      sendText(response, "subagent-child-ok");
    } else if (requestHasText(body, "Subagent verification")) {
      if (requestHasToolResult(body)) sendText(response, "subagent-ok");
      else sendAgentToolUse(response);
    } else if (requestHasResumePrompt(body)) {
      sendText(response, "resume-ok");
    } else if (requestHasToolResult(body)) {
      sendText(response, "mcp-ok");
    } else {
      sendToolUse(response);
    }
  });

  try {
    const port = await listen(server);
    const transportEnvironment = buildAgentSdkTransportEnvironment({
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: "spike-token",
    });
    const environment = {
      ...process.env,
      ...transportEnvironment,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: "0",
      CLAUDE_CONFIG_DIR: configDirectory,
    };
    const mcpServer = runtime.createSdkMcpServer({
      name: "spike",
      tools: [
        runtime.tool(
          "echo",
          "Echo a value for deterministic Agent SDK verification",
          { value: z.string() },
          async ({ value }) => {
            mcpCalls += 1;
            return { content: [{ type: "text", text: `echo:${value}` }] };
          },
        ),
      ],
    });
    const sharedOptions = {
      allowedTools: [MCP_TOOL_NAME],
      cwd: workDirectory,
      env: environment,
      executable: "node",
      hooks: {
        PreToolUse: [
          {
            matcher: MCP_TOOL_NAME,
            hooks: [
              async () => {
                hookCalls += 1;
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              },
            ],
          },
        ],
      },
      maxTurns: 2,
      mcpServers: { spike: mcpServer },
      model: MODEL,
      settingSources: ["project"],
      skills: ["spike-skill"],
      tools: [MCP_TOOL_NAME],
    };

    const firstMessages = [];
    for await (const message of runtime.query({
      prompt: "Call the echo tool with first-turn, then report its result.",
      options: sharedOptions,
    })) {
      firstMessages.push(message);
    }
    const firstResult = resultMessage(firstMessages);
    const firstInit = initMessage(firstMessages);

    const resumeMessages = [];
    for await (const message of runtime.query({
      prompt: "Resume verification: reply with resume-ok.",
      options: {
        ...sharedOptions,
        maxTurns: 1,
        resume: firstResult.session_id,
      },
    })) {
      resumeMessages.push(message);
    }
    const resumeResult = resultMessage(resumeMessages);
    const subagentMessages = [];
    for await (const message of runtime.query({
      prompt: "Subagent verification: delegate to spike-agent and report subagent-ok.",
      options: {
        ...sharedOptions,
        agents: {
          "spike-agent": {
            description: "Deterministic fake-provider verification agent",
            prompt: "Follow the verification prompt exactly.",
            tools: [],
            model: MODEL,
            maxTurns: 1,
          },
        },
        allowedTools: ["Agent"],
        maxTurns: 3,
        skills: [],
        tools: ["Agent"],
      },
    })) {
      subagentMessages.push(message);
    }
    const subagentResult = resultMessage(subagentMessages);

    const refusalMessages = [];
    try {
      for await (const message of runtime.query({
        prompt: "Refusal verification: emit the provider refusal fixture.",
        options: {
          ...sharedOptions,
          allowedTools: [],
          maxTurns: 1,
          skills: [],
          tools: [],
        },
      })) {
        refusalMessages.push(message);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("can't help")) {
        throw error;
      }
    }
    const refusalResult = refusalMessages.findLast(
      (message) => message.type === "result",
    );
    const refusalEvent = refusalMessages.find(
      (message) =>
        message.type === "system" && message.subtype === "model_refusal_no_fallback",
    );
    if (!refusalEvent) {
      throw new Error("Agent SDK did not emit a structured no-fallback refusal");
    }

    const abortController = new AbortController();
    const cancellationStartedAt = Date.now();
    const cancellationRun = (async () => {
      try {
        for await (const _message of runtime.query({
          prompt: "Cancellation verification: wait for the provider.",
          options: {
            ...sharedOptions,
            abortController,
            maxTurns: 1,
          },
        })) {
          // The fake provider deliberately never starts this response.
        }
      } catch (error) {
        if (
          error?.name !== "AbortError" &&
          !(typeof runtime.AbortError === "function" && error instanceof runtime.AbortError)
        ) {
          throw error;
        }
      }
    })();
    await withDeadline(cancellationRequestSeen, 5_000, "cancellation request");
    abortController.abort();
    await withDeadline(cancellationRun, 5_000, "Agent SDK cancellation");
    const cancellationDurationMs = Date.now() - cancellationStartedAt;
    const firstRequest = requests[0];
    const usage = Object.values(firstResult.modelUsage)[0];
    if (!firstRequest || !usage) {
      throw new Error("Agent SDK fake-provider report is incomplete");
    }

    return {
      sdkVersion: artifactReport.version,
      transport: {
        authorization:
          firstRequest.authorization === "Bearer spike-token" ? "present" : "missing",
        baseUrl: "loopback",
        messagesPath: firstRequest.path,
        anthropicBeta: firstRequest.anthropicBeta ?? "",
      },
      firstTurn: {
        hookCalls,
        mcpCalls,
        result: firstResult.result,
        skillLoaded: firstInit.skills?.includes("spike-skill") ?? false,
        usageModel: usage.canonicalModel,
      },
      resume: {
        result: resumeResult.result,
        reusedSession: resumeResult.session_id === firstResult.session_id,
      },
      subagent: {
        result: subagentResult.result,
        spawned: subagentResult.subagent_stats?.spawned ?? 0,
      },
      refusal: {
        structuredEvent: refusalEvent.subtype,
        stopReason: refusalResult?.stop_reason ?? "refusal",
      },
      cancellation: {
        aborted: abortController.signal.aborted,
        withinDeadline: cancellationDurationMs < 5_000,
      },
    };
  } finally {
    if (server.listening) await closeServer(server);
    await rm(workDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}
