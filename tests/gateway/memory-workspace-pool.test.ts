import { describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
const poolState = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  end: vi.fn(),
  on: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(config: Record<string, unknown>) {
        poolState.config = config;
      }
      on = poolState.on;
      end = poolState.end;
      async connect() {
        return {
          query: async () => ({
            rows: [{ one: 1 }],
            rowCount: 1,
            command: "SELECT",
          }),
          release: vi.fn(),
        };
      }
    },
  },
}));
import { MemoryWorkspaceRepository } from "../../packages/gateway/src/memory-workspace/repository.js";
describe("owned memory Postgres pool", () => {
  it("bounds connection acquisition and statement execution and closes its owned pool", async () => {
    const repository = MemoryWorkspaceRepository.fromConnectionString(
      "postgresql://localhost/disposable",
    );
    expect(poolState.config).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      query_timeout: 35000,
    });
    expect(poolState.on).toHaveBeenCalledWith("error", expect.any(Function));
    await sql`SELECT 1`.execute(repository.kysely);
    await repository.destroy();
    expect(poolState.end).toHaveBeenCalledOnce();
  });
});
