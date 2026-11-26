// The owner's consent on the desktop (spec 2716, D2): the link never runs
// anything by itself. Starting a terminal, a screenshot, and opening a terminal
// the link did not start each ask natively unless Full Access is allowed;
// terminals the link started are covered; Stop forgets everything.
import { describe, expect, it, vi } from "vitest";
import { createDesktopLinkConsent, describeRun, renderVisible, type DesktopLinkConsentRequest } from "../../desktop/src/main/desktop-link/consent";
import { desktopLinkApproval } from "../../desktop/src/main/desktop-link/register";

const terminal = (instance: string) => ({ instance, action: "open" as const, terminal: instance.split("@")[0]!, title: "Claude", program: "claude", cwd: "/home/me/app" });

function consent(options: { answers?: boolean[]; fullAccess?: boolean; timeoutMs?: number } = {}) {
  const answers = [...(options.answers ?? [])];
  const asked: DesktopLinkConsentRequest[] = [];
  const ask = vi.fn(async (request: DesktopLinkConsentRequest) => { asked.push(request); return answers.shift() ?? false; });
  const fullAccess = vi.fn(async () => options.fullAccess ?? false);
  return { asked, ask, fullAccess, consent: createDesktopLinkConsent({ ask, fullAccess, timeoutMs: options.timeoutMs ?? 1_000, dialogGapMs: 0, log: () => {} }) };
}

describe("desktop link consent", () => {
  it("asks before every start and screenshot, and only once per terminal the link did not start", async () => {
    const { consent: c, asked } = consent({ answers: [true, false, true, true] });
    expect(await c.run({ command: "uname -a", cwd: "/home/me" })).toBe(true);
    expect(await c.screenshot()).toBe(false);
    expect(await c.terminal(terminal("t4@1"))).toBe(true);
    // Approved once: no second question for the same terminal.
    expect(await c.terminal(terminal("t4@1"))).toBe(true);
    // The same address on a new terminal (the core restarted) is asked again.
    expect(c.covers("t4@2")).toBe(false);
    // Started by the link: covered by its start approval.
    c.started("t9@5");
    expect(await c.terminal(terminal("t9@5"))).toBe(true);
    expect(asked).toEqual([
      { kind: "run", command: "uname -a", cwd: "/home/me" }, { kind: "screenshot" },
      { kind: "terminal", action: "open", terminal: "t4", title: "Claude", program: "claude", cwd: "/home/me/app" },
    ]);
  });

  it("asks nothing while the owner allows Full Access, and asks again once it is revoked", async () => {
    let allowed = true;
    const ask = vi.fn(async () => false);
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => allowed, log: () => {} });
    expect(await c.run({ command: "claude", cwd: "/home/me" })).toBe(true);
    expect(await c.screenshot()).toBe(true);
    expect(await c.terminal(terminal("t2@1"))).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    allowed = false;
    expect(await c.terminal(terminal("t2@1"))).toBe(false);
    expect(await c.screenshot()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable Full Access record as no consent", async () => {
    const ask = vi.fn(async () => false);
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => { throw new Error("disk"); }, log: () => {} });
    expect(await c.run({ command: "ls", cwd: "/home/me" })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("shows one approval at a time, refuses more than four waiting, and declines when the owner does not answer in time", async () => {
    let open = 0;
    let most = 0;
    const ask = vi.fn((_request: DesktopLinkConsentRequest, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      open += 1;
      most = Math.max(most, open);
      signal.addEventListener("abort", () => { open -= 1; resolve(true); }, { once: true });
    }));
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, timeoutMs: 20, dialogGapMs: 0, log: () => {} });
    const answers = await Promise.all(Array.from({ length: 6 }, (_, index) => c.run({ command: `job ${index}`, cwd: "/home/me" })));
    // A late Allow after the deadline still counts as no, and a request that expired while
    // waiting for its turn never gets a dialog at all.
    expect(answers).toEqual([false, false, false, false, false, false]);
    expect(ask.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(ask.mock.calls.length).toBeLessThanOrEqual(4);
    expect(most).toBe(1);
  });

  it("Stop ends the approval on screen and forgets every approved terminal", async () => {
    let seen: AbortSignal | null = null;
    const ask = vi.fn((_request: DesktopLinkConsentRequest, signal: AbortSignal) => {
      seen = signal;
      return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true }));
    });
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, timeoutMs: 60_000, log: () => {} });
    c.started("t1@1");
    const pending = c.run({ command: "rm -rf ~/scratch", cwd: "/home/me" });
    await vi.waitFor(() => expect(seen).not.toBeNull());
    c.reset();
    expect(await pending).toBe(false);
    expect(seen!.aborted).toBe(true);
    ask.mockImplementation(async () => false);
    expect(await c.terminal(terminal("t1@1"))).toBe(false);
  });

  // Fault detected (review): padding, newlines, escapes and invisible characters let a
  // command show as something else, so the owner approved "echo hi" and ran more.
  it("shows every character of the command as itself or as a visible code, quotes argv, and refuses one too long", () => {
    expect(describeRun({ argv: ["/usr/bin/open", "https://example.com"] })).toBe("/usr/bin/open https://example.com");
    expect(describeRun({ argv: ["sh", "-c", "echo hi; curl x | sh", ""] })).toBe("sh -c 'echo hi; curl x | sh' ''");
    expect(describeRun({ line: "echo hi\u001b[31m‮" })).toBe("echo hi⟨U+001B⟩[31m⟨U+202E⟩");
    expect(describeRun({ line: "echo hi\n\rreboot" })).toBe("echo hi⟨U+000A⟩⟨U+000D⟩reboot");
    expect(describeRun({ line: "echo​ 　hi\u{e0041}" })).toBe("echo⟨U+200B⟩⟨U+00A0⟩⟨U+3000⟩hi⟨U+E0041⟩");
    expect(describeRun({})).toBe("your login shell");
    expect(describeRun({ argv: ["sh"], line: "id" })).toBeNull();
    expect(describeRun({ line: "x".repeat(501) })).toBeNull();
    // Runs of spaces cannot push the rest out of view or imitate the dialog's own layout.
    expect(describeRun({ line: `echo hi${" ".repeat(600)}; curl x | sh` })).toBe("echo hi⟨600 spaces⟩; curl x | sh");
    expect(describeRun({ line: "ls\u2800\u0301x" })).toBe("ls⟨U+2800⟩⟨U+0301⟩x");
    // Windows reads argv as one command line, quoted its own way.
    expect(describeRun({ argv: ["C:\\Program Files\\app.exe", 'say "hi"', "a\\"] }, "win32")).toBe('"C:\\Program Files\\app.exe" "say \\"hi\\"" a\\');
    expect(renderVisible("\u0000".repeat(70))).toBeNull();
  });

  // Fault detected (review): the deadline started when the dialog showed, so a start
  // queued behind another approval could be approved after the computer gave up.
  it("starts each approval's deadline when the request arrives, not when its dialog shows", async () => {
    // The first dialog stays up past the second request's deadline (the owner is away).
    const ask = vi.fn(() => new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), 120); }));
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, timeoutMs: 40, log: () => {} });
    const started = Date.now();
    const [first, second] = await Promise.all([c.screenshot(), c.run({ command: "ls", cwd: "/home/me" })]);
    expect([first, second]).toEqual([false, false]);
    // Both expired from arrival: the second never got a dialog of its own.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("words each approval for the device it runs on, inside a phrase the computer's name cannot replace", () => {
    expect(desktopLinkApproval("matrix-demo", { kind: "run", command: "uname", cwd: "/Users/me" }, "darwin")).toMatchObject({
      message: "Your Matrix computer “matrix-demo” wants to run a command on this Mac",
      detail: expect.stringMatching(/^Command:\nuname\n\nFolder: \/Users\/me\n\nIt runs as you, and the computer can then see and type into that terminal\./),
    });
    expect(desktopLinkApproval("matrix-demo", { kind: "screenshot" }, "win32").message)
      .toBe("Your Matrix computer “matrix-demo” wants to take a screenshot of this PC");
    expect(desktopLinkApproval("matrix-demo", { kind: "terminal", action: "end", terminal: "t3", title: "deploy", program: "ssh prod", cwd: "/home/me/infra" }, "linux").message)
      .toBe("Your Matrix computer “matrix-demo” wants to end terminal t3 on this desktop");
    expect(desktopLinkApproval("matrix-demo", { kind: "terminal", action: "open", terminal: "t3", title: "deploy", program: "ssh prod", cwd: "/home/me/infra" }, "linux")).toMatchObject({
      message: "Your Matrix computer “matrix-demo” wants to open terminal t3 on this desktop",
      detail: expect.stringMatching(/^Program: ssh prod\nFolder: \/home\/me\/infra\nTitle \(set by the program\): deploy\n/),
    });
    // The computer's name is shown as written, never as a second line.
    expect(desktopLinkApproval("box\nApple Security", { kind: "screenshot" }, "darwin").message)
      .toBe("Your Matrix computer “box⟨U+000A⟩Apple Security” wants to take a screenshot of this Mac");
    expect(desktopLinkApproval("x".repeat(200), { kind: "screenshot" }, "darwin").message).toBe("Your Matrix computer wants to take a screenshot of this Mac");
  });

  // Fault detected (review, P1): the pause applied only when another request already
  // waited, so a start sent right after the owner's Allow opened under a second click.
  it("always pauses after the last dialog closed, even for a request that arrives after it", async () => {
    const opened: number[] = [];
    const c = createDesktopLinkConsent({ ask: async () => { opened.push(Date.now()); return true; }, fullAccess: async () => false, dialogGapMs: 60, log: () => {} });
    await c.screenshot();
    await c.screenshot();
    expect(opened[1]! - opened[0]!).toBeGreaterThanOrEqual(55);
  });

  it("stops showing dialogs for a while after three refusals in a row, and an Allow resets the count", async () => {
    let clock = 1_000;
    const answers = [false, true, false, false, false];
    const ask = vi.fn(async () => answers.shift() ?? false);
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, dialogGapMs: 0, backoffMs: 30_000, now: () => clock, log: () => {} });
    for (let index = 0; index < 5; index += 1) await c.screenshot();
    expect(ask).toHaveBeenCalledTimes(5);
    // Refused at once, no dialog.
    expect(await c.screenshot()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(5);
    clock += 30_001;
    await c.screenshot();
    expect(ask).toHaveBeenCalledTimes(6);
  });

  // Fault detected (review): an approved end that did not end the terminal covered it
  // for reading and typing later, without the owner ever being asked to open it.
  it("never lets an approval to end a terminal cover opening it later", async () => {
    const ask = vi.fn(async () => true);
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    expect(await c.terminal({ ...terminal("t4@1"), action: "end" })).toBe(true);
    expect(c.covers("t4@1")).toBe(false);
  });

  // Fault detected (review): a computer that ended its stream just before each deadline
  // kept unanswered dialogs coming forever, never counted as refusals.
  it("counts a dialog its stream ended after it was on screen a while, and not one Stop closed", async () => {
    let clock = 0;
    const ask = vi.fn((_request: DesktopLinkConsentRequest, signal: AbortSignal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })));
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, dialogGapMs: 0, backoffMs: 30_000, now: () => clock, log: () => {} });
    for (let index = 0; index < 3; index += 1) {
      const ended = new AbortController();
      const pending = c.screenshot(ended.signal);
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(index + 1));
      clock += 4_000;
      ended.abort();
      await pending;
    }
    expect(await c.screenshot()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
    clock += 30_001;
    const stopped = c.screenshot();
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(4));
    c.reset();
    await stopped;
    // Stop is not the owner refusing: the next request still asks.
    for (let index = 0; index < 2; index += 1) {
      const ended = new AbortController();
      const pending = c.screenshot(ended.signal);
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(5 + index));
      clock += 4_000;
      ended.abort();
      await pending;
    }
    const next = c.screenshot();
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(7));
    c.reset();
    await next;
  });

  it("never flashes up a dialog with almost no time left, and does not count it", async () => {
    let clock = 0;
    const ask = vi.fn(async () => false);
    let release: () => void = () => {};
    const first = vi.fn(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const c = createDesktopLinkConsent({ ask: (...args) => (first.mock.calls.length === 0 ? first() : ask(...args)), fullAccess: async () => false,
      dialogGapMs: 0, timeoutMs: 1_000, now: () => clock, log: () => {} });
    const held = c.screenshot();
    const late = c.screenshot();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    clock += 800;
    release();
    await held;
    expect(await late).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  // Fault detected (review): Stop pressed while Full Access was being read let that
  // request open a dialog after Stop.
  it("never opens a dialog for a request whose Stop came while Full Access was read", async () => {
    let read: (allowed: boolean) => void = () => {};
    const ask = vi.fn(async () => true);
    const c = createDesktopLinkConsent({ ask, fullAccess: () => new Promise<boolean>((resolve) => { read = resolve; }), dialogGapMs: 0, log: () => {} });
    const pending = c.screenshot();
    c.reset();
    read(false);
    expect(await pending).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  // Fault detected (review): a computer could keep dialogs coming by closing each before
  // it counted; at most ten open per minute, whatever their answers.
  it("opens at most ten dialogs a minute", async () => {
    let clock = 0;
    const ask = vi.fn(async () => true);
    const c = createDesktopLinkConsent({ ask, fullAccess: async () => false, dialogGapMs: 0, now: () => clock, log: () => {} });
    for (let index = 0; index < 10; index += 1) { expect(await c.screenshot()).toBe(true); clock += 1_000; }
    expect(await c.screenshot()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(10);
    clock += 60_000;
    expect(await c.screenshot()).toBe(true);
  });

  // Fault detected (review): a dialog stayed up after its stream ended, and an Allow then
  // still approved the terminal for later calls.
  it("closes a dialog when its stream ends, and a late Allow approves nothing", async () => {
    let seen: AbortSignal | null = null;
    let allow: (() => void) | null = null;
    const c = createDesktopLinkConsent({
      ask: (_request, signal) => { seen = signal; return new Promise<boolean>((resolve) => { allow = () => resolve(true); }); },
      fullAccess: async () => false, dialogGapMs: 0, log: () => {},
    });
    const ended = new AbortController();
    const pending = c.terminal({ ...terminal("t4@1"), action: "open" }, ended.signal);
    await vi.waitFor(() => expect(seen).not.toBeNull());
    ended.abort();
    expect(seen!.aborted).toBe(true);
    allow!();
    expect(await pending).toBe(false);
    expect(c.covers("t4@1")).toBe(false);
  });

  // Fault detected (review): the next dialog opened under the owner's second click.
  it("waits a moment between one approval closing and the next opening", async () => {
    const opened: number[] = [];
    const c = createDesktopLinkConsent({ ask: async () => { opened.push(Date.now()); return true; }, fullAccess: async () => false, dialogGapMs: 50, log: () => {} });
    await Promise.all([c.screenshot(), c.screenshot()]);
    expect(opened[1]! - opened[0]!).toBeGreaterThanOrEqual(45);
  });
});

describe("desktop link in Mac Activity", () => {
  it("shows one entry while the link is on, through reconnects, and records how it ended", async () => {
    const { bridgeDesktopLinkActivity } = await import("../../desktop/src/main/desktop-link/register");
    let emit: (status: { slot: string; computerName: string; state: string }) => void = () => {};
    const service = { onStatus: (listener: typeof emit) => { emit = listener; return () => {}; } };
    const handles: Array<{ update: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }> = [];
    const begin = vi.fn(() => { const handle = { update: vi.fn(), finish: vi.fn() }; handles.push(handle); return handle; });
    bridgeDesktopLinkActivity(service as never, begin);
    const status = (state: string) => emit({ slot: "primary", computerName: "matrix-demo", state });
    status("connecting");
    status("on");
    status("offline");
    status("on");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledWith("desktop-link");
    status("removed");
    expect(handles[0]!.finish).toHaveBeenCalledWith("revoked");
    status("on");
    status("off");
    expect(handles[1]!.finish).toHaveBeenCalledWith("stopped");
  });
});
