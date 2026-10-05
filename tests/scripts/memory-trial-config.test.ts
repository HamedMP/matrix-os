import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const modulePath = resolve("scripts/memory-trial/configure.py");
function render(patch: Record<string, string> = {}) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('trial',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ne={'MATRIX_MEMORY_HINDSIGHT_DATABASE_URL':'postgresql://trial:synthetic@127.0.0.1/hindsight','MEMORY_TRIAL_LLM_MODEL':'synthetic-model','MEMORY_TRIAL_EMBEDDING_MODEL':'synthetic-embedding','MEMORY_TRIAL_EMBEDDING_DIMENSION':'1536','MEMORY_TRIAL_RERANK_MODEL':'synthetic-rerank','MEMORY_TRIAL_OPENAI_API_KEY':'synthetic-key','MEMORY_TRIAL_COHERE_API_KEY':'synthetic-key'}\ne.update(json.loads(sys.argv[2]))\ntry: print(json.dumps(m.configuration(e)))\nexcept ValueError: print(json.dumps({'error':'invalid'}))`,
        modulePath,
        JSON.stringify(patch),
      ],
      { timeout: 10000, encoding: "utf8" },
    ),
  );
}
describe("native private memory trial configuration", () => {
  it("stores locally and configures the same cloud model budget", () => {
    const [h, o] = render();
    expect(h.HINDSIGHT_API_DATABASE_URL).toContain("127.0.0.1");
    expect(h.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS).toBe("1536");
    expect(o.server).toEqual({
      host: "127.0.0.1",
      port: 1933,
      cors_origins: [],
    });
    expect(o.storage).toMatchObject({
      workspace: "/var/lib/matrix-memory-trial/openviking",
      agfs: { backend: "local" },
      vectordb: { backend: "local" },
    });
    expect(o.vlm.model).toBe(h.HINDSIGHT_API_LLM_MODEL);
    expect(o.rerank.log_payloads).toBe(false);
  });
  it("rejects remote storage, invalid dimensions and environment injection", () => {
    for (const patch of [
      {
        MATRIX_MEMORY_HINDSIGHT_DATABASE_URL:
          "postgresql://trial:secret@remote.example/db",
      },
      { MEMORY_TRIAL_EMBEDDING_DIMENSION: "0" },
      { MEMORY_TRIAL_OPENAI_API_KEY: "key\nEVIL=yes" },
    ])
      expect(render(patch)).toEqual({ error: "invalid" });
  });
  it("keeps native services non-root, loopback-only, bounded and separate from production", () => {
    for (const name of ["hindsight", "openviking"]) {
      const unit = readFileSync(
        resolve(`scripts/memory-trial/${name}.service`),
        "utf8",
      );
      expect(unit).toContain("User=matrix");
      expect(unit).toContain("127.0.0.1");
      expect(unit).toContain("MemoryMax=2G");
      expect(unit).toContain("NoNewPrivileges=true");
    }
    expect(
      readFileSync(resolve("scripts/memory-trial/install.sh"), "utf8"),
    ).not.toContain("matrix-update");
  });
});
