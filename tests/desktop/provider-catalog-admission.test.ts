import { afterEach, expect, it, vi } from "vitest";
import { postWithProviderCatalogRecovery } from "../../desktop/src/renderer/src/features/chat/provider-catalog-admission";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { AppError } from "../../desktop/src/shared/app-error";
afterEach(() => { useConnection.setState(useConnection.getInitialState(), true); });

it.each([new Error("provider_unavailable"), new AppError("timeout"), new AppError("server", { detail: "thread_busy" })])("does not invalidate catalogs for unrelated or untrusted failures: %s", async error => {
  const api = { post: vi.fn().mockRejectedValue(error) };
  await expect(postWithProviderCatalogRecovery(api, "/api/chats/chat_one/turns", { selection: { instanceId: "codex_default", model: "gpt-6-sol" } })).rejects.toBe(error);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});
it("does not invalidate on unrelated writes even if a safe error code mentions availability", async () => {
  const error = new AppError("server", { detail: "provider_unavailable" });
  await expect(postWithProviderCatalogRecovery({ post: vi.fn().mockRejectedValue(error) }, "/api/files", {})).rejects.toBe(error);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});
it("ignores an old admission failure after auth identity changes", async () => {
  let reject!: (reason: Error) => void;
  const api = { post: vi.fn(() => new Promise((_resolve, no) => { reject = no; })) };
  const pending = postWithProviderCatalogRecovery(api, "/api/chats/chat_one/turns", {});
  useConnection.setState({ authGeneration: 1 });
  const error = new AppError("server", { detail: "provider_unavailable" });
  reject(error);
  await expect(pending).rejects.toBe(error);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});
it.each(["insufficient_credit", "credit_reserved", "budget_exceeded"])("conservatively suspends unknown routes for rejected queue funding admission: %s", async code => {
  const error = new AppError("server", { detail: code });
  await expect(postWithProviderCatalogRecovery({ post: vi.fn().mockRejectedValue(error) }, "/api/chats/chat_one/queued-turns", {})).rejects.toBe(error);
  expect(useConnection.getState().providerCatalogGeneration).toBe(1);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
});

it("suspends all routes on a typed authentication rejection without requiring an availability detail", async () => {
  const error = new AppError("unauthorized");
  await expect(postWithProviderCatalogRecovery({ post: vi.fn().mockRejectedValue(error) }, "/api/chats/chat_one/turns", { selection: { instanceId: "codex_default", model: "gpt-6-sol" } })).rejects.toBe(error);
  expect(useConnection.getState().providerCatalogGeneration).toBe(1);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
});
