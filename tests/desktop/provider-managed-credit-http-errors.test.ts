import { expect, it, vi } from "vitest";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createDesktopProviderSettingsTransport } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";

it.each([401, 403, 404, 405])("stops HTTP%s from its status without buffering an unbounded error body", async status => {
  const cancel = vi.fn();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; controller.enqueue(new Uint8Array(32 * 1024)); },
    cancel,
  });
  const response = new Response(body, { status });
  const clone = vi.spyOn(response, "clone");
  const api = createApiClient({ baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn: vi.fn().mockResolvedValue(response) });
  const transport = createDesktopProviderSettingsTransport(api);
  const result = transport.getManagedCredit!(new AbortController().signal);
  const rejected = expect(result).rejects.toMatchObject({ code: status === 404 || status === 405 ? "managed_credit_unsupported" : "managed_credit_unauthorized" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect.soft(clone).not.toHaveBeenCalled();
  expect.soft(cancel).toHaveBeenCalledTimes(1);
  // Release the old unbounded reader so a failing test never hangs.
  if (clone.mock.calls.length) stream.close();
  await rejected;
});
