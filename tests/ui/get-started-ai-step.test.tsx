// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function port() {
  const saves: GetStartedUpdate[] = [];
  const value: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 3, name: "Sam", goals: ["code"], tools: [] } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      return update.type === "complete" ? { status: "completed", completedAt: AT, answers: update.answers } : { status: "in_progress", updatedAt: AT, draft: update.type === "draft" ? update.draft : {} };
    }),
  };
  return { port: value, saves };
}

afterEach(() => cleanup());

describe("Make your AI yours", () => {
  it("names the AI, previews its style, shows what it writes, and saves it", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    expect(await screen.findByRole("dialog", { name: "Give your AI a name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atlas" }));
    fireEvent.click(screen.getByRole("button", { name: "Straight shooter" }));
    expect(screen.getByText("Here's the fix. One warning: that change will lock the table.")).toBeInTheDocument();
    expect(screen.getByText("Always asks before doing anything outside Matrix.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Short" }));
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(screen.getByText("Here's the fix.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "See what this writes" }));
    expect(screen.getByText(/Your name is Atlas\. You are Sam's personal Matrix assistant\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Atlas · Straight shooter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({
      type: "complete",
      answers: { name: "Sam", bot: { name: "Atlas", personality: "straight-shooter", length: "short", emoji: "never" } },
    }));
  });

  it("keeps the AI as Matrix when the step is skipped", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Atlas" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect((await screen.findByText("Your AI")).nextElementSibling).toHaveTextContent(/^Matrix$/);
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)?.type).toBe("complete"));
    expect(saves.at(-1)).not.toHaveProperty("answers.bot");
  });

  it("accepts a typed name", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "Juno" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText(/^Juno · /)).toBeInTheDocument();
  });

  it("shows the name that will be saved when the typed one is blank", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect((await screen.findByText("Your AI")).nextElementSibling).toHaveTextContent(/^Matrix · /);
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { bot: { name: "Matrix" } } }));
  });

  it("keeps a typed name that starts with a suggestion", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    const input = await screen.findByLabelText("AI name");
    fireEvent.change(input, { target: { value: "Atlas" } });
    expect(input).toHaveValue("Atlas");
    fireEvent.change(input, { target: { value: "AtlasPrime" } });
    expect(input).toHaveValue("AtlasPrime");
  });

  it("blocks names the Matrix Bot cannot use, with a reason", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "Task-master" } });
    expect(screen.getByRole("alert")).toHaveTextContent("That name can't be used. Try another.");
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AI name"), { target: { value: "Taskmaster" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });

  it("says which choices the sample reply reflects", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    expect(await screen.findByText(/Language, tone and humour apply in real chats\./)).toBeInTheDocument();
  });
});
