# Contract: TUI Actions And Execution

This contract defines internal CLI TUI behavior. It is tested through `packages/sync-client/tests/tui/*` and must stay stable enough for views and executor tests.

## Action Registry

Each action has:

```ts
type TuiAction = {
  id: string;
  title: string;
  group: string;
  aliases: string[];
  intents: string[];
  shortcut?: string;
  handler: "view" | "flow" | "direct-command" | "external-attach";
  directCommand?: string;
  danger: "none" | "confirm" | "exact-phrase";
  confirmationPhrase?: string;
  refreshAfter?: boolean;
  prerequisites?: Array<"auth" | "gateway" | "local-profile">;
};
```

Rules:
- `id` is the only executable key.
- Palette search text never executes directly.
- Destructive actions require `danger !== "none"`.
- `directCommand` is parsed from trusted registry data only.

## Executor Interface

```ts
type TuiActionExecutionState =
  | { state: "idle" }
  | { state: "confirming"; action: TuiAction }
  | { state: "running"; action: TuiAction; message: string }
  | { state: "succeeded"; action: TuiAction; message: string; refreshStatus: boolean }
  | { state: "failed"; action: TuiAction; code: string; message: string; hint?: string }
  | { state: "cancelled"; action: TuiAction; message: string };

type TuiActionExecutor = {
  execute(action: TuiAction): Promise<TuiActionExecutionState>;
  confirm(action: TuiAction, input?: string): Promise<TuiActionExecutionState>;
  cancel(action: TuiAction): TuiActionExecutionState;
};
```

## Required MVP Actions

| Action ID | Home Shortcut | Behavior | Refresh |
|-----------|---------------|----------|---------|
| `shell.new` | `n` | Create a safe default shell session or prompt for a name | yes |
| `shell.sessions` | `s` | Open Sessions view and list sessions | yes |
| `setup.agents` | `a` | Open setup wizard | no until completion |
| `status.doctor` | `d` | Run doctor/status diagnostic flow | yes |
| `account.login` | `l` | Run login flow or show direct login instructions | yes |
| `utility.palette` | `/` | Open command palette | no |
| `utility.quit` | `q` | Exit TUI | no |

## Error Output

TUI action errors return:

```ts
type TuiSafeActionError = {
  code: string;
  message: string; // <= 240 chars
  hint?: string;
};
```

Messages must not include raw stack traces, raw gateway response bodies, provider secrets, tokens, or unnormalized filesystem paths.
