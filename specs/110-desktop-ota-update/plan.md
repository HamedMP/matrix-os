# Desktop OTA Update Entry Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ready-to-install Desktop update action into its own footer row below Settings, preserving one-click installation and a compact collapsed-sidebar control.

**Architecture:** Keep update state and installation behavior inside the existing `DesktopUpdateButton`; add a required `collapsed` presentation prop so that component owns both expanded and collapsed renderings. `Sidebar` remains responsible only for footer ordering and passes its existing collapsed state into the update component. No IPC, updater, persistence, or What's New logic changes.

**Tech Stack:** React 19, TypeScript 5.9 strict mode, Zustand 5, Tailwind CSS 4, Vitest 4, Testing Library, Playwright Electron.

## Global Constraints

- Use the existing `ready` snapshot state and `update:install` IPC operation; do not change the update protocol.
- Selecting Update immediately restarts and installs the downloaded release; do not add confirmation UI.
- Render no update chrome unless the snapshot is `ready` with a valid version.
- Expanded footer order is Runtime computer selector, Settings, Update, Account.
- Expanded mode displays `Update` and `v{version}`; collapsed mode displays only the icon while retaining the accessible label and tooltip `Update Matrix OS to {version}`.
- Keep the account row composition and width independent of update availability.
- Use TDD: every production change follows a verified failing test.
- Use pnpm for package management and bun for repository scripts; do not use npm.

---

## File Map

- Modify `desktop/src/renderer/src/features/updates/DesktopUpdateButton.tsx`: own the ready-state footer slot, expanded row, collapsed icon, accessible label, and existing install action.
- Modify `desktop/src/renderer/src/features/mission-control/Sidebar.tsx`: pass `collapsed` and place the update component between Settings and the account row.
- Modify `tests/desktop/desktop-update-ui.test.tsx`: specify expanded/collapsed update-button rendering and retain immediate-install coverage.
- Modify `tests/desktop/sidebar-attention-badges.test.tsx`: specify footer DOM order and separation from the account row.
- Modify `tests/e2e/desktop/update-experience.e2e.test.ts`: verify the real Electron layout in expanded and collapsed sidebar modes and refresh evidence screenshots.

### Task 1: Give the update control expanded and collapsed renderings

**Files:**
- Modify: `tests/desktop/desktop-update-ui.test.tsx`
- Modify: `desktop/src/renderer/src/features/updates/DesktopUpdateButton.tsx`

**Interfaces:**
- Consumes: `useDesktopUpdate((state) => state.snapshot | state.installing | state.install)`.
- Produces: `DesktopUpdateButton({ collapsed }: { collapsed: boolean }): JSX.Element | null`.

- [ ] **Step 1: Add the failing responsive-rendering test**

Append a focused test to `tests/desktop/desktop-update-ui.test.tsx` after the existing blue-control test:

```tsx
it("renders a full update row when expanded and an icon-only control when collapsed", () => {
  vi.stubGlobal("operator", { invoke: vi.fn(), on: vi.fn() });
  useDesktopUpdate.setState({
    snapshot: { status: "ready", version: "1.2.3", progress: 100 },
  });

  const view = render(
    <Tooltip.Provider>
      <DesktopUpdateButton collapsed={false} />
    </Tooltip.Provider>,
  );

  expect(screen.getByText("Update")).toBeTruthy();
  expect(screen.getByText("v1.2.3")).toBeTruthy();

  view.rerender(
    <Tooltip.Provider>
      <DesktopUpdateButton collapsed />
    </Tooltip.Provider>,
  );

  const collapsedButton = screen.getByRole("button", {
    name: "Update Matrix OS to 1.2.3",
  });
  expect(collapsedButton.getAttribute("title")).toBe("Update Matrix OS to 1.2.3");
  expect(screen.queryByText("Update")).toBeNull();
  expect(screen.queryByText("v1.2.3")).toBeNull();
});
```

Update the two existing direct renders in the blue-control test to pass `collapsed={false}` so the public component contract is explicit.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run test tests/desktop/desktop-update-ui.test.tsx
```

Expected: FAIL because `DesktopUpdateButton` ignores the new presentation prop and does not render the `Update` or `v1.2.3` text.

- [ ] **Step 3: Implement the minimal responsive component**

Change `DesktopUpdateButton.tsx` to accept the required prop, return no wrapper before the update is ready, and own its footer padding only when visible:

```tsx
import { Download, LoaderCircle } from "lucide-react";
import { useDesktopUpdate } from "../../stores/desktop-update";

interface DesktopUpdateButtonProps {
  collapsed: boolean;
}

export default function DesktopUpdateButton({ collapsed }: DesktopUpdateButtonProps) {
  const snapshot = useDesktopUpdate((state) => state.snapshot);
  const installing = useDesktopUpdate((state) => state.installing);
  const install = useDesktopUpdate((state) => state.install);

  if (snapshot.status !== "ready" || !snapshot.version) return null;

  const label = `Update Matrix OS to ${snapshot.version}`;
  return (
    <div className={`px-2 pt-1 ${collapsed ? "flex justify-center" : ""}`}>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={installing}
        className={`no-drag flex h-7 items-center rounded-md text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-80 ${collapsed ? "w-7 justify-center" : "w-full gap-2 px-2.5 text-xs font-semibold"}`}
        style={{ background: "var(--update-action)" }}
        onClick={() => void install()}
      >
        {installing ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Download size={14} className="shrink-0" />}
        {!collapsed ? (
          <>
            <span>Update</span>
            <span className="ml-auto opacity-75">v{snapshot.version}</span>
          </>
        ) : null}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun run test tests/desktop/desktop-update-ui.test.tsx
```

Expected: all desktop update UI tests PASS, including existing immediate-install and ready-only assertions.

- [ ] **Step 5: Commit the responsive control**

```bash
git add tests/desktop/desktop-update-ui.test.tsx desktop/src/renderer/src/features/updates/DesktopUpdateButton.tsx
git commit -m "refactor(desktop): make update action responsive"
```

### Task 2: Move Update below Settings and prove the footer order

**Files:**
- Modify: `tests/desktop/sidebar-attention-badges.test.tsx`
- Modify: `desktop/src/renderer/src/features/mission-control/Sidebar.tsx`

**Interfaces:**
- Consumes: `DesktopUpdateButton({ collapsed })` from Task 1 and `useUi((state) => state.sidebarCollapsed)`.
- Produces: footer DOM order Runtime, Settings, Update, Account without changing any navigation or account handlers.

- [ ] **Step 1: Add the failing footer-order test**

Import the update store in `tests/desktop/sidebar-attention-badges.test.tsx`:

```tsx
import { useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";
```

Reset it in `beforeEach`:

```tsx
useDesktopUpdate.setState({
  snapshot: { status: "disabled" },
  installing: false,
});
```

Then append:

```tsx
it("places a ready update after Settings and outside the account row", () => {
  useDesktopUpdate.setState({
    snapshot: { status: "ready", version: "1.2.3", progress: 100 },
  });

  render(
    <Tooltip.Provider>
      <Sidebar />
    </Tooltip.Provider>,
  );

  const settings = screen.getByRole("button", { name: "Settings" });
  const update = screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" });
  const account = screen.getByTitle("Manage account");

  expect(settings.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(update.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(update.parentElement).not.toBe(account.parentElement);
});
```

- [ ] **Step 2: Run the sidebar test and verify RED**

Run:

```bash
bun run test tests/desktop/sidebar-attention-badges.test.tsx
```

Expected: FAIL because the current Update button remains inside the account row after the avatar instead of between Settings and Account.

- [ ] **Step 3: Move the component in `Sidebar.tsx`**

Remove `DesktopUpdateButton` from the account-row `<div>`. Render it directly after the Settings row wrapper and before the account-row wrapper:

```tsx
<div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"} px-2 pt-1`}>
  <NavRow
    icon={<Settings size={15} />}
    label="Settings"
    collapsed={collapsed}
    active={activeTab?.kind === "settings"}
    onClick={() => openTab({ kind: "settings", title: "Settings" })}
  />
</div>
<DesktopUpdateButton collapsed={collapsed} />
<div className={`flex gap-2 p-2 ${collapsed ? "flex-col items-center" : "items-center"}`}>
  <button
    type="button"
    title="Manage account"
    className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
    style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
    onClick={() => void invoke("shell:open-external", { url: platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com" })}
  >
    {showAvatar && imageUrl ? (
      <img
        src={imageUrl}
        alt=""
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
      />
    ) : (
      avatarInitial
    )}
  </button>
  {collapsed ? (
    <IconButton label="Expand sidebar (⌘B)" onClick={toggleSidebar}>
      <PanelLeftOpen size={15} />
    </IconButton>
  ) : (
    <>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
        {secondaryLabel ? (
          <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span>
        ) : null}
      </div>
      <IconButton label="Collapse sidebar (⌘B)" onClick={toggleSidebar}>
        <PanelLeftClose size={15} />
      </IconButton>
      <IconButton
        label="Sign out"
        onClick={() => {
          void signOut().catch((err: unknown) => {
            console.warn(
              "[sidebar] sign-out failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }}
      >
        <LogOut size={14} />
      </IconButton>
    </>
  )}
</div>
```

- [ ] **Step 4: Run focused update and sidebar tests and verify GREEN**

Run:

```bash
bun run test tests/desktop/desktop-update-ui.test.tsx tests/desktop/sidebar-attention-badges.test.tsx
```

Expected: both files PASS; the account row behavior and existing attention badges remain green.

- [ ] **Step 5: Commit the footer placement**

```bash
git add tests/desktop/sidebar-attention-badges.test.tsx desktop/src/renderer/src/features/mission-control/Sidebar.tsx
git commit -m "fix(desktop): separate update action from account row"
```

### Task 3: Verify the real Electron layout and refresh evidence

**Files:**
- Modify: `tests/e2e/desktop/update-experience.e2e.test.ts`
- Generated evidence: `desktop/screenshots/mat-291-update-ready.png`
- Generated evidence: `desktop/screenshots/mat-291-update-ready-collapsed.png`

**Interfaces:**
- Consumes: the accessible update name, Sidebar Settings control, Manage account control, and Collapse sidebar control.
- Produces: an E2E regression proving vertical footer order, expanded full-row geometry, and collapsed icon geometry.

- [ ] **Step 1: Change the E2E assertion and verify RED against the existing build**

Rename the test to:

```ts
it("shows What's New after launch and places Update below Settings", async () => {
```

Replace the old avatar-x proximity assertion with:

```ts
const settings = page.getByRole("button", { name: "Settings" });
const avatar = page.getByTitle("Manage account");
const settingsBox = await settings.boundingBox();
const updateBox = await update.boundingBox();
const avatarBox = await avatar.boundingBox();
expect(settingsBox).not.toBeNull();
expect(updateBox).not.toBeNull();
expect(avatarBox).not.toBeNull();
expect(updateBox?.y ?? 0).toBeGreaterThan((settingsBox?.y ?? 0) + (settingsBox?.height ?? 0));
expect((updateBox?.y ?? 0) + (updateBox?.height ?? 0)).toBeLessThanOrEqual(avatarBox?.y ?? 0);
expect(updateBox?.width ?? 0).toBeGreaterThan((avatarBox?.width ?? 0) * 4);
```

Run the existing build without rebuilding product code:

```bash
bun run test:e2e tests/e2e/desktop/update-experience.e2e.test.ts
```

Expected: FAIL because the built renderer still places Update beside the avatar and renders it as a small circle.

- [ ] **Step 2: Add collapsed-sidebar geometry coverage**

After capturing `mat-291-update-ready.png`, add:

```ts
await page.getByRole("button", { name: "Collapse sidebar (⌘B)" }).click();
const collapsedUpdateBox = await update.boundingBox();
expect(collapsedUpdateBox).not.toBeNull();
expect(Math.abs((collapsedUpdateBox?.width ?? 0) - (collapsedUpdateBox?.height ?? 0))).toBeLessThanOrEqual(2);
expect(collapsedUpdateBox?.width ?? 0).toBeLessThan(40);
await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-291-update-ready-collapsed.png") });
```

- [ ] **Step 3: Build Desktop and verify the E2E test GREEN**

Run:

```bash
bun run build:desktop
bun run test:e2e tests/e2e/desktop/update-experience.e2e.test.ts
```

Expected: Desktop build succeeds and the E2E file reports 1 PASS with both refreshed screenshots written.

- [ ] **Step 4: Run proportional regression checks**

Run:

```bash
bun run test tests/desktop/desktop-update-ui.test.tsx tests/desktop/sidebar-attention-badges.test.tsx tests/desktop/updater.test.ts tests/desktop/update-config.test.ts tests/desktop/local-store.test.ts tests/desktop/ipc-handlers.test.ts tests/desktop/ipc-contract.test.ts
bun run test tests/desktop
pnpm --filter desktop run typecheck
bun run check:patterns:diff
git diff --check
```

Expected: focused update tests, complete Desktop tests, Desktop typecheck, pattern scan, and whitespace validation all PASS. Any unrelated repository-wide baseline failure must be reported separately rather than attributed to this placement change.

- [ ] **Step 5: Commit E2E coverage**

```bash
git add tests/e2e/desktop/update-experience.e2e.test.ts
git commit -m "test(desktop): cover update footer placement"
```

- [ ] **Step 6: Inspect the real Electron screenshots and relaunch the preview**

Inspect `desktop/screenshots/mat-291-update-ready.png` and `desktop/screenshots/mat-291-update-ready-collapsed.png` at original resolution. Confirm that the expanded action is between Settings and Account, the account name is not compressed, and the collapsed action is centered at the same footer position. Relaunch the MAT-291 build with an isolated `OPERATOR_USER_DATA_DIR` and a dedicated remote-debugging port, then read back the Electron process command, worktree path, commit, listener port, and active page URL before handing it to the user. Keep unrelated Electron applications running.

- [ ] **Step 7: Update the existing review handoff**

Push the branch, update GitHub PR #1192 and Linear MAT-291 in English with the final commit, test counts, screenshots, and exact-head CI/Greptile status. Do not merge either PR.
