import { createNativeRoutineClient } from "../lib/requests/routines";
const session = async () => ({token: "test-token", gatewayUrl: "https://app.matrix-os.com/vm/test?runtime=dev"});
const id = "rt_" + "a".repeat(24);
let request: jest.SpyInstance;
beforeEach(() => { request = jest.spyOn(global, "fetch").mockResolvedValue({ok: true, json: async () => ({items: [], pending: [], nextCursor: null})} as Response); });
afterEach(() => jest.restoreAllMocks());
it("keeps the normal Computer path, runtime slot, current token and timeout on a validated list request", async () => {
  await createNativeRoutineClient(session).list({archived: "true"});
  const [url, input] = request.mock.calls[0];
  expect(url).toBe("https://app.matrix-os.com/vm/test/api/bot-routines?runtime=dev&archived=true");
  expect(input.headers.Authorization).toBe("Bearer test-token");
  expect(input.signal).toBeDefined();
  expect(input.body).toBeUndefined();
});
it("sends only an explicit revision-bound control through the normal native authenticated transport", async () => {
  request.mockResolvedValueOnce({ok: true, json: async () => ({routineId: id, status: "paused", revision: 4})} as Response);
  await createNativeRoutineClient(session).control(id, {status: "paused", baseRevision: 3});
  expect(request.mock.calls[0][1].method).toBe("POST");
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({status: "paused", baseRevision: 3});
});
it("rejects owner fields and malformed identifiers before making an HTTP call", async () => {
  const api = createNativeRoutineClient(session);
  await expect(async () => api.control(id, {status: "paused", baseRevision: 3, ownerId: "foreign"} as never)).rejects.toThrow();
  await expect(async () => api.detail("../foreign")).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("does not turn missing login, malformed response or server errors into a successful operation", async () => {
  await expect(createNativeRoutineClient(async () => null).list()).rejects.toThrow("Schedules are temporarily unavailable.");
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ok: true, json: async () => ({items: [], pending: [], nextCursor: null, ownerId: "foreign"})} as Response);
  await expect(createNativeRoutineClient(session).list()).rejects.toThrow("Schedules are temporarily unavailable.");
  request.mockResolvedValueOnce({ok: false, status: 500, json: async () => ({error: "postgres://private"})} as Response);
  await expect(createNativeRoutineClient(session).detail(id)).rejects.toThrow("Schedules are temporarily unavailable.");
});
