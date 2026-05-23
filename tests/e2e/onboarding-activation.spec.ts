import { expect, test } from "@playwright/test";

test.describe("onboarding activation", () => {
  async function openManualSetup(page: import("@playwright/test").Page) {
    await page.route("**/api/settings/onboarding-status", async (route) => {
      await route.fulfill({ json: { complete: false } });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Matrix OS" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Set up manually/i }).click();
  }

  test("shows goal-based activation and readiness copy", async ({ page }) => {
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [
            { id: "coding", selected: false, label: "Code with Matrix", description: "Ship code" },
            { id: "assistant", selected: false, label: "Use Matrix as an assistant", description: "Operate tasks" },
          ],
          gates: [
            {
              id: "hermes.continuity",
              category: "agent",
              criticality: "release_critical",
              status: "pass",
              message: "Hermes remains available as the Matrix system agent",
              remediation: null,
              owner: "matrix",
              lastCheckedAt: null,
            },
          ],
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          agents: [],
        },
      });
    });
    await page.route("**/api/onboarding/goals", async (route) => {
      await route.fulfill({
        json: {
          goalIds: ["coding"],
          steps: [
            { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding"] },
          ],
        },
      });
    });

    await openManualSetup(page);
    await expect(page.getByText("Set up Matrix around the work you want done first.")).toBeVisible();
    await page.getByRole("button", { name: /Code with Matrix/i }).click();
    await expect(page.getByText("Required · Connect GitHub")).toBeVisible();
    await expect(page.getByText("Hermes is available as the Matrix system agent")).toBeVisible();
  });

  test("handholds the coding setup path with project, issue source, Symphony, and terminal context", async ({ page }) => {
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [
            { id: "coding", selected: true, label: "Code with Matrix", description: "Ship code" },
          ],
          gates: [
            {
              id: "github.connected",
              category: "integration",
              criticality: "goal_required",
              status: "pass",
              message: "GitHub is connected for coding workflows",
              remediation: null,
              owner: "user",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
            {
              id: "project.selected",
              category: "coding",
              criticality: "goal_required",
              status: "pass",
              message: "Matrix OS is selected for coding work",
              remediation: null,
              owner: "user",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
            {
              id: "issue_source.selected",
              category: "coding",
              criticality: "goal_required",
              status: "fail",
              message: "Choose a task source before starting coding work",
              remediation: "Connect Linear or choose a Matrix task list",
              owner: "user",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
            {
              id: "symphony.ready",
              category: "coding",
              criticality: "goal_required",
              status: "pass",
              message: "Symphony is ready to dispatch coding work",
              remediation: null,
              owner: "matrix",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
            {
              id: "terminal.ready",
              category: "coding",
              criticality: "goal_required",
              status: "checking",
              message: "Terminal context is ready to open for Matrix OS",
              remediation: "Open the Matrix terminal for the selected project",
              owner: "matrix",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
          ],
          systemAgent: "hermes",
          activeAgents: ["codex", "hermes"],
          agents: [],
        },
      });
    });
    await page.route("**/api/onboarding/goals", async (route) => {
      await route.fulfill({
        json: {
          goalIds: ["coding"],
          steps: [
            { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding"] },
            { id: "project.selected", required: true, title: "Choose a project", unlocks: ["coding"] },
            { id: "issue_source.selected", required: true, title: "Choose task source", unlocks: ["coding"] },
            { id: "symphony.ready", required: true, title: "Prepare Symphony", unlocks: ["coding"] },
            { id: "terminal.ready", required: false, title: "Open terminal context", unlocks: ["coding"] },
          ],
        },
      });
    });

    await openManualSetup(page);

    await expect(page.getByText("Coding setup")).toBeVisible();
    await expect(page.getByText("GitHub connected")).toBeVisible();
    await expect(page.getByText("Choose task source")).toBeVisible();
    await expect(page.getByRole("button", { name: /Open terminal context/i })).toBeVisible();
  });

  test("explains no-Claude onboarding with Hermes still active", async ({ page }) => {
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [
            { id: "app_building", selected: true, label: "Build apps", description: "Build Matrix apps" },
          ],
          gates: [
            {
              id: "hermes.continuity",
              category: "agent",
              criticality: "release_critical",
              status: "pass",
              message: "Hermes remains available as the Matrix system agent",
              remediation: null,
              owner: "matrix",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
          ],
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          agents: [],
        },
      });
    });
    await page.route("**/api/agents/credentials/status", async (route) => {
      await route.fulfill({
        json: {
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          routingExplanation: "Hermes remains the Matrix system agent even when Claude and Codex are not connected.",
          agents: [
            { agent: "claude", status: "missing", coordinationRole: "core_agent", workflows: ["core_agent"], degradedWorkflows: ["core_agent"], verifiedAt: null, nextAction: "Connect Claude to enable the core agent path" },
            { agent: "codex", status: "missing", coordinationRole: "coding_specialist", workflows: ["coding"], degradedWorkflows: ["coding"], verifiedAt: null, nextAction: "Connect Codex for optional coding support" },
            { agent: "hermes", status: "available", coordinationRole: "system_agent", workflows: ["app_building", "assistant", "integrations"], degradedWorkflows: [], verifiedAt: null, nextAction: null },
          ],
        },
      });
    });

    await openManualSetup(page);

    await expect(page.getByText("Agent setup")).toBeVisible();
    await expect(page.getByText("Hermes is the Matrix system agent")).toBeVisible();
    await expect(page.getByText("Claude is not connected")).toBeVisible();
    await expect(page.getByText("Hermes remains the Matrix system agent even when Claude and Codex are not connected.")).toBeVisible();
  });

  test("shows assistant integration approvals for calendar and email", async ({ page }) => {
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [
            { id: "assistant", selected: true, label: "Use Matrix as an assistant", description: "Operate tasks" },
          ],
          gates: [
            {
              id: "integrations.capabilities",
              category: "integration",
              criticality: "goal_required",
              status: "fail",
              message: "Approve one assistant capability for Hermes",
              remediation: "Approve calendar, email, or summary capabilities",
              owner: "user",
              lastCheckedAt: "2026-05-23T00:00:00.000Z",
            },
          ],
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          agents: [],
        },
      });
    });
    await page.route("**/api/agents/credentials/status", async (route) => {
      await route.fulfill({
        json: {
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          routingExplanation: "Hermes remains the Matrix system agent.",
          agents: [],
        },
      });
    });
    await page.route("**/api/integrations/capabilities", async (route) => {
      await route.fulfill({
        json: {
          capabilities: [
            { id: "calendar.create_event", provider: "calendar", capability: "create_calendar_event", status: "connected", approvedAgents: [], requiresApprovalPerAction: true },
            { id: "email.read_email", provider: "email", capability: "read_email", status: "connect_required", approvedAgents: [], requiresApprovalPerAction: true },
          ],
        },
      });
    });

    await page.goto("/");

    await expect(page.getByText("Assistant integrations")).toBeVisible();
    await expect(page.getByText("Calendar event")).toBeVisible();
    await expect(page.getByText("Email summaries")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve Hermes/i })).toBeVisible();
  });
});
