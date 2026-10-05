import {
  forgetJourneyConnectable,
  rememberJourneyConnectable,
  wasJourneyConnectable,
} from "../lib/journey-cache";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
  };
}

beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

it("remembers that a user's computer was connectable", async () => {
  const storage = memoryStorage();
  await rememberJourneyConnectable("user_a", storage, NOW);

  expect(await wasJourneyConnectable("user_a", storage, NOW + DAY_MS)).toBe(true);
});

it("does not apply one user's answer to another", async () => {
  const storage = memoryStorage();
  await rememberJourneyConnectable("user_a", storage, NOW);

  expect(await wasJourneyConnectable("user_b", storage, NOW)).toBe(false);
});

it("stops trusting an answer after a week", async () => {
  const storage = memoryStorage();
  await rememberJourneyConnectable("user_a", storage, NOW);

  expect(await wasJourneyConnectable("user_a", storage, NOW + 8 * DAY_MS)).toBe(false);
});

it("has no answer once forgotten", async () => {
  const storage = memoryStorage();
  await rememberJourneyConnectable("user_a", storage, NOW);
  await forgetJourneyConnectable(null, storage);

  expect(await wasJourneyConnectable("user_a", storage, NOW)).toBe(false);
});

it("forgets only the named user's answer", async () => {
  const storage = memoryStorage();
  await rememberJourneyConnectable("user_b", storage, NOW);

  await forgetJourneyConnectable("user_a", storage);
  expect(await wasJourneyConnectable("user_b", storage, NOW)).toBe(true);

  await forgetJourneyConnectable("user_b", storage);
  expect(await wasJourneyConnectable("user_b", storage, NOW)).toBe(false);
});

it("has no answer when nothing was remembered, the value is damaged, or storage fails", async () => {
  const storage = memoryStorage();
  expect(await wasJourneyConnectable("user_a", storage, NOW)).toBe(false);

  storage.values.set("matrix_os_journey_ready_v1", "{not json");
  expect(await wasJourneyConnectable("user_a", storage, NOW)).toBe(false);

  storage.getItem.mockRejectedValue(new Error("storage unavailable"));
  expect(await wasJourneyConnectable("user_a", storage, NOW)).toBe(false);
});

it("does not fail the caller when storage cannot be written or cleared", async () => {
  const storage = memoryStorage();
  storage.setItem.mockRejectedValue(new Error("storage full"));
  storage.removeItem.mockRejectedValue(new Error("storage unavailable"));

  await expect(rememberJourneyConnectable("user_a", storage, NOW)).resolves.toBeUndefined();
  await expect(forgetJourneyConnectable(null, storage)).resolves.toBeUndefined();
});
