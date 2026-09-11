import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpGatewayClient } from "./clients.js";
import { jsonResult, safeErrorResult } from "./errors.js";
import { createMcpProfileContext, type McpProfileContext } from "./profile-context.js";
import {
  ComputerInputSchema,
  CreateTerminalInputSchema,
  CreateTerminalTabInputSchema,
  DownloadFileInputSchema,
  GetChatInputSchema,
  ListChatsInputSchema,
  ListFilesInputSchema,
  ReadFileInputSchema,
  RunCommandInputSchema,
  SearchChatsInputSchema,
  SelectTerminalTabInputSchema,
  SendTerminalInputSchema,
  TerminalInputSchema,
  UploadFileInputSchema,
  decodeUploadContent,
} from "./schemas.js";

export interface MatrixMcpServerOptions {
  context?: McpProfileContext;
  profileName?: string;
  configDir?: string;
  apiOrigin?: string;
  fetch?: typeof fetch;
  /** Hosted HTTP budget; absent preserves the CLI's existing command limits. */
  maxCommandTimeoutMs?: number;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const changeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const executionAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

async function safely<T>(operation: () => Promise<T>) {
  try {
    return jsonResult(await operation());
  } catch (error: unknown) {
    return safeErrorResult(error);
  }
}

function publicComputer(computer: Awaited<ReturnType<McpProfileContext["listComputers"]>>["items"][number]) {
  return {
    runtimeSlot: computer.runtimeSlot,
    handle: computer.handle,
    label: computer.label,
    availability: computer.availability,
    kind: computer.kind,
    ...(computer.versionLabel ? { versionLabel: computer.versionLabel } : {}),
    capabilities: computer.capabilities,
  };
}

function computerResult(computer: { runtimeSlot: string; handle: string }) {
  return { runtimeSlot: computer.runtimeSlot, handle: computer.handle };
}

export function createMatrixMcpServer(options: MatrixMcpServerOptions = {}): McpServer {
  const profileContext = options.context ?? createMcpProfileContext({
    profileName: options.profileName,
    configDir: options.configDir,
    apiOrigin: options.apiOrigin,
    fetch: options.fetch,
  });
  const server = new McpServer(
    { name: "matrix-remote-computer", version: "1.0.0" },
    {
      instructions:
        "Use these tools to work on an explicitly selected Matrix computer. Call list_computers first. Use run_command for captured one-shot output and persistent terminal tools for visible long-running work. Never imply these tools disable the host's local shell.",
    },
  );

  async function withClient<T>(computer: string, operation: (
    client: ReturnType<typeof createMcpGatewayClient>,
    selected: { runtimeSlot: string; handle: string },
  ) => Promise<T>): Promise<T> {
    const runtime = await profileContext.resolveRuntime(computer);
    return operation(
      createMcpGatewayClient(runtime, { fetch: options.fetch }),
      computerResult(runtime.computer),
    );
  }

  server.registerTool("list_computers", {
    description: "List Matrix computers available to the signed-in owner. Call this before any computer-scoped tool.",
    annotations: readOnlyAnnotations,
  }, async () => safely(async () => {
    const inventory = await profileContext.listComputers();
    return {
      ok: true,
      computers: inventory.items.map(publicComputer),
      selectedSlot: inventory.selectedSlot,
      hasMore: inventory.hasMore,
    };
  }));

  server.registerTool("run_command", {
    description: "Run a captured argv command on one explicit Matrix computer and return bounded output and exit metadata.",
    inputSchema: options.maxCommandTimeoutMs
      ? { ...RunCommandInputSchema.shape, timeoutMs: RunCommandInputSchema.shape.timeoutMs.unwrap().max(options.maxCommandTimeoutMs).optional() }
      : RunCommandInputSchema.shape,
    annotations: executionAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    ...await client.runCommand({
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...((input.timeoutMs ?? options.maxCommandTimeoutMs) ? { timeoutMs: input.timeoutMs ?? options.maxCommandTimeoutMs } : {}),
    }),
  }))));

  server.registerTool("list_terminals", {
    description: "List persistent zellij terminal sessions on one explicit Matrix computer.",
    inputSchema: ComputerInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true, computer, terminals: await client.listTerminals(),
  }))));

  server.registerTool("create_terminal", {
    description: "Create a named persistent zellij terminal on one explicit Matrix computer.",
    inputSchema: CreateTerminalInputSchema.shape,
    annotations: changeAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    terminal: await client.createTerminal({ name: input.name, ...(input.cwd ? { cwd: input.cwd } : {}) }),
  }))));

  server.registerTool("list_terminal_tabs", {
    description: "List tabs in a named persistent Matrix terminal.",
    inputSchema: TerminalInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true, computer, terminal: input.terminal, tabs: await client.listTabs(input.terminal),
  }))));

  server.registerTool("create_terminal_tab", {
    description: "Create a tab in a named persistent Matrix terminal.",
    inputSchema: CreateTerminalTabInputSchema.shape,
    annotations: changeAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    terminal: input.terminal,
    tab: await client.createTab(input.terminal, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }),
  }))));

  server.registerTool("select_terminal_tab", {
    description: "Select the active tab by its stable Matrix tab ID before sending input.",
    inputSchema: SelectTerminalTabInputSchema.shape,
    annotations: changeAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => {
    await client.selectTab(input.terminal, input.tabId);
    return { ok: true, computer, terminal: input.terminal, tabId: input.tabId };
  })));

  server.registerTool("send_terminal_input", {
    description: "Send bounded input to the active tab of a persistent Matrix terminal. Include a newline to submit a shell command.",
    inputSchema: SendTerminalInputSchema.shape,
    annotations: executionAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => {
    await client.sendTerminalInput(input.terminal, input.data);
    return {
      ok: true,
      computer,
      terminal: input.terminal,
      bytes: Buffer.byteLength(input.data, "utf8"),
    };
  })));

  server.registerTool("list_files", {
    description: "List a bounded Matrix-home directory on one explicit Matrix computer.",
    inputSchema: ListFilesInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true, computer, path: input.path, entries: await client.listFiles(input.path),
  }))));

  server.registerTool("read_file", {
    description: "Read a UTF-8 Matrix-home file up to 256 KiB without writing to the local computer.",
    inputSchema: ReadFileInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true, computer, path: input.path, encoding: "utf8", ...await client.readFile(input.path),
  }))));

  server.registerTool("download_file", {
    description: "Return a Matrix-home file up to 1 MiB as base64 content; never writes a local path.",
    inputSchema: DownloadFileInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => {
    const downloaded = await client.downloadFile(input.path);
    return {
      ok: true,
      computer,
      path: input.path,
      filename: downloaded.filename,
      mediaType: downloaded.mediaType,
      size: downloaded.size,
      encoding: "base64",
      content: downloaded.bytes.toString("base64"),
    };
  })));

  server.registerTool("upload_file", {
    description: "Upload bounded UTF-8 or base64 content to Matrix home. Existing files require overwrite=true.",
    inputSchema: UploadFileInputSchema.shape,
    annotations: executionAnnotations,
  }, async (input) => safely(async () => {
    const validated = UploadFileInputSchema.parse(input);
    return withClient(validated.computer, async (client, computer) => {
      const uploaded = await client.uploadFile(validated.path, decodeUploadContent(validated), {
        overwrite: validated.overwrite,
        secret: validated.secret,
      });
      return { computer, ...uploaded };
    });
  }));

  server.registerTool("list_chats", {
    description: "List a bounded page of read-only Matrix chat summaries on one explicit computer.",
    inputSchema: ListChatsInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    ...await client.listChats({
      limit: input.limit,
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }) as Record<string, unknown>,
  }))));

  server.registerTool("search_chats", {
    description: "Search read-only Matrix chat summaries on one explicit computer.",
    inputSchema: SearchChatsInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    ...await client.searchChats({
      query: input.query,
      limit: input.limit,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }) as Record<string, unknown>,
  }))));

  server.registerTool("get_chat", {
    description: "Read bounded metadata and messages for one Matrix chat without changing chat state.",
    inputSchema: GetChatInputSchema.shape,
    annotations: readOnlyAnnotations,
  }, async (input) => safely(() => withClient(input.computer, async (client, computer) => ({
    ok: true,
    computer,
    ...await client.getChat({
      chatId: input.chatId,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }) as Record<string, unknown>,
  }))));

  return server;
}
