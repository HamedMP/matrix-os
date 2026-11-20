import { MESSAGE_BOARD_ERROR_REASONS, type BoardSocketFrame, type MessageBoardErrorReason } from "@matrix-os/contracts/message-board";
import { MessageBoardError, type BoardEventListener, type MessageBoardClient } from "./client.js";
import type {
  BoardActor, BoardChannel, BoardMessage, BoardSchedule, BoardSummary, BoardThread, BoardThreadSummary, BoardWatcher,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const THREAD_PAGE = 200;
const MAX_ROOT_CHANNELS = 500;
const PING_MS = 20_000;
const STALE_MS = 50_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_FRAME_CHARS = 1024 * 1024;
const KNOWN_REASONS = new Set<string>(MESSAGE_BOARD_ERROR_REASONS);

/** The parts of a browser WebSocket the client uses. */
export interface BoardEventsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface HttpMessageBoardClientOptions {
  /** Gateway origin, for example from `getGatewayUrl()`. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Authenticated `/ws/board/events?…` URL for a board, or null when live updates are unavailable. */
  eventsUrl?: (query: Record<string, string>) => string | null | Promise<string | null>;
  createSocket?: (url: string) => BoardEventsSocket;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

function reasonOf(value: unknown): MessageBoardErrorReason | null {
  const reason = (value as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && KNOWN_REASONS.has(reason) ? reason as MessageBoardErrorReason : null;
}

/** `MessageBoardClient` over the gateway's `/api/board` routes and `/ws/board/events`. */
export function createHttpMessageBoardClient(options: HttpMessageBoardClientOptions): MessageBoardClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = `${options.baseUrl.replace(/\/+$/, "")}/api/board`;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  // Replies need their thread's channel; remember it from reads (bounded, oldest out).
  const rootChannels = new Map<string, string>();
  const remember = (rootId: string, channel: string) => {
    rootChannels.delete(rootId);
    rootChannels.set(rootId, channel);
    while (rootChannels.size > MAX_ROOT_CHANNELS) {
      const oldest = rootChannels.keys().next().value;
      if (oldest === undefined) break;
      rootChannels.delete(oldest);
    }
  };

  async function request<T>(method: string, path: string, board: string | undefined, body?: unknown, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries({ ...query, board })) if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        cache: "no-store",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      console.warn("[message-board] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new MessageBoardError("unavailable");
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) console.warn("[message-board] response unreadable", error instanceof Error ? error.name : "UnknownError");
    }
    if (!response.ok) {
      throw new MessageBoardError(reasonOf(payload) ?? (response.status === 401 || response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "unavailable"));
    }
    return payload as T;
  }

  /** Lists that only exist once watchers and schedules ship: a missing route is an empty list. */
  async function optionalList<T>(path: string, board: string, key: string): Promise<T[]> {
    try {
      return (await request<Record<string, T[]>>("GET", path, board))[key] ?? [];
    } catch (error: unknown) {
      if (error instanceof MessageBoardError && error.reason === "not_found") return [];
      throw error;
    }
  }

  async function channelFor(board: string, rootId: string): Promise<string> {
    const known = rootChannels.get(rootId);
    if (known) return known;
    const { thread } = await request<{ thread: BoardThread }>("GET", `/threads/${rootId}`, board);
    remember(thread.root.id, thread.root.channel);
    return thread.root.channel;
  }

  const task = (board: string, id: string, verb: string, body: Record<string, unknown> = {}) =>
    request<unknown>("POST", `/tasks/${id}/${verb}`, board, body).then(() => undefined);

  return {
    whoami: async () => (await request<{ actor: BoardActor }>("GET", "/whoami", undefined)).actor,
    listBoards: async () => (await request<{ boards: BoardSummary[] }>("GET", "/boards", undefined)).boards,
    listActors: async (board) => (await request<{ actors: BoardActor[] }>("GET", "/actors", board)).actors,
    listChannels: async (board) => (await request<{ channels: BoardChannel[] }>("GET", "/channels", board)).channels,
    async listThreads(board, channel) {
      const { threads } = await request<{ threads: BoardThreadSummary[] }>("GET", "/threads", board, undefined, { channel, limit: THREAD_PAGE });
      for (const thread of threads) remember(thread.root.id, thread.root.channel);
      return threads;
    },
    async getThread(board, rootId) {
      const { thread } = await request<{ thread: BoardThread }>("GET", `/threads/${rootId}`, board);
      remember(thread.root.id, thread.root.channel);
      return thread;
    },
    markRead: (board, rootId) => request<unknown>("POST", `/threads/${rootId}/read`, board, {}).then(() => undefined),

    async post(board, input) {
      if (input.task) {
        const created = await request<{ root: BoardMessage }>("POST", "/tasks", board, {
          channel: input.channel, text: input.text, ...(input.labels ? { labels: input.labels } : {}),
          ...(input.task.needs?.length ? { needs: input.task.needs } : {}), ...(input.task.forProfile ? { forProfile: input.task.forProfile } : {}),
        });
        remember(created.root.id, created.root.channel);
        return created.root;
      }
      const { message } = await request<{ message: BoardMessage }>("POST", "/messages", board, {
        channel: input.channel, text: input.text, ...(input.labels ? { labels: input.labels } : {}),
      });
      remember(message.id, message.channel);
      return message;
    },
    async reply(board, rootId, input) {
      const channel = await channelFor(board, rootId);
      return (await request<{ message: BoardMessage }>("POST", "/messages", board, {
        channel, text: input.text, re: rootId, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      })).message;
    },
    edit: async (board, id, text, ifRevision) => (await request<{ message: BoardMessage }>("PATCH", `/messages/${id}`, board, { text, ifRevision })).message,
    remove: (board, id) => request<unknown>("DELETE", `/messages/${id}`, board, {}).then(() => undefined),
    react: (board, id, emoji, on) => request<unknown>("POST", `/messages/${id}/reactions`, board, { emoji, on }).then(() => undefined),
    label: (board, id, patch) => request<unknown>("PATCH", `/messages/${id}/labels`, board, patch).then(() => undefined),

    createTask: (board, rootId, taskOptions = {}) => request<unknown>("POST", "/tasks", board, { rootId, ...taskOptions }).then(() => undefined),
    claimTask: (board, id) => request<unknown>("POST", "/tasks/claim", board, { id }).then(() => undefined),
    renewTask: (board, id) => task(board, id, "renew"),
    releaseTask: (board, id) => task(board, id, "release"),
    completeTask: (board, id, result) => task(board, id, "complete", result ? { result } : {}),
    failTask: (board, id, reason) => task(board, id, "fail", { reason }),
    blockTask: (board, id, reason, kind) => task(board, id, "block", { reason, ...(kind ? { kind } : {}) }),
    unblockTask: (board, id) => task(board, id, "unblock"),
    reopenTask: (board, id) => task(board, id, "reopen"),
    assignTask: (board, id, profile) => task(board, id, "assign", { profile }),
    cancelTask: (board, id, reason) => task(board, id, "cancel", { reason }),

    listWatchers: (board) => optionalList<BoardWatcher>("/watchers", board, "watchers"),
    setWatcherEnabled: (board, id, enabled) => request<unknown>("PATCH", `/watchers/${id}`, board, { enabled }).then(() => undefined),
    listSchedules: (board) => optionalList<BoardSchedule>("/schedules", board, "schedules"),
    cancelSchedule: (board, id) => request<unknown>("DELETE", `/schedules/${id}`, board, {}).then(() => undefined),

    subscribe(board, listener) {
      return subscribeToBoard({ board, listener, eventsUrl: options.eventsUrl, createSocket: options.createSocket, setTimer, clearTimer, now });
    },
  };
}

/** One socket per subscription: pings, resumes from its last cursor after a drop or `missed`, backs off on failure. */
function subscribeToBoard(input: {
  board: string;
  listener: BoardEventListener;
  eventsUrl?: HttpMessageBoardClientOptions["eventsUrl"];
  createSocket?: HttpMessageBoardClientOptions["createSocket"];
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}): () => void {
  const { eventsUrl, createSocket, setTimer, clearTimer, now } = input;
  if (!eventsUrl || !createSocket) return () => undefined;
  let stopped = false;
  let socket: BoardEventsSocket | null = null;
  let cursor: string | null = null;
  let retry: unknown = null;
  let ping: unknown = null;
  let backoff = RECONNECT_MIN_MS;
  let lastFrameAt = 0;

  const scheduleReconnect = () => {
    if (stopped || retry !== null) return;
    retry = setTimer(() => { retry = null; void connect(); }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const keepAlive = (opened: BoardEventsSocket) => {
    ping = setTimer(() => {
      ping = null;
      if (socket !== opened || stopped) return;
      if (now() - lastFrameAt > STALE_MS) {
        drop(opened);
        try { opened.close(4000, "heartbeat timeout"); } catch (error: unknown) {
          console.warn("[message-board] socket close failed", error instanceof Error ? error.name : "UnknownError");
        }
        return;
      }
      try { opened.send(JSON.stringify({ type: "ping" })); } catch (error: unknown) {
        console.warn("[message-board] ping failed", error instanceof Error ? error.name : "UnknownError");
      }
      keepAlive(opened);
    }, PING_MS);
  };

  const drop = (opened: BoardEventsSocket) => {
    if (socket !== opened) return;
    socket = null;
    if (ping !== null) clearTimer(ping);
    ping = null;
    scheduleReconnect();
  };

  const connect = async () => {
    if (stopped || socket) return;
    const query: Record<string, string> = { board: input.board, ...(cursor ? { after: cursor } : {}) };
    let url: string | null;
    try {
      url = await eventsUrl(query);
    } catch (error: unknown) {
      console.warn("[message-board] events url unavailable", error instanceof Error ? error.name : "UnknownError");
      url = null;
    }
    if (stopped || socket) return;
    if (!url) { scheduleReconnect(); return; }
    let opened: BoardEventsSocket;
    try {
      opened = createSocket(url);
    } catch (error: unknown) {
      console.warn("[message-board] socket failed", error instanceof Error ? error.name : "UnknownError");
      scheduleReconnect();
      return;
    }
    socket = opened;
    opened.onopen = () => {
      backoff = RECONNECT_MIN_MS;
      lastFrameAt = now();
      keepAlive(opened);
    };
    // react-doctor-disable-next-line react-doctor/postmessage-origin-risk -- a WebSocket from this client's own authenticated URL, not window.postMessage
    opened.onmessage = (event) => {
      if (socket !== opened || stopped) return;
      lastFrameAt = now();
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME_CHARS) return;
      let frame: BoardSocketFrame;
      try {
        frame = JSON.parse(event.data) as BoardSocketFrame;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) console.warn("[message-board] frame unreadable", error instanceof Error ? error.name : "UnknownError");
        return;
      }
      if (frame.type === "event" && frame.event && typeof frame.event.cursor === "string") {
        cursor = frame.event.cursor;
        try {
          input.listener(frame.event);
        } catch (error: unknown) {
          console.warn("[message-board] listener failed", error instanceof Error ? error.name : "UnknownError");
        }
      } else if ((frame.type === "ready" || frame.type === "missed") && typeof frame.cursor === "string") {
        cursor = frame.cursor;
      }
    };
    opened.onclose = () => drop(opened);
    opened.onerror = () => drop(opened);
  };

  void connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimer(retry);
    if (ping !== null) clearTimer(ping);
    retry = null;
    ping = null;
    const open = socket;
    socket = null;
    try { open?.close(1000, "unsubscribed"); } catch (error: unknown) {
      console.warn("[message-board] socket close failed", error instanceof Error ? error.name : "UnknownError");
    }
  };
}
