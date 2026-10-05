import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const modulePath = resolve("scripts/memory-trial/configure.py");
function render(patch: Record<string, string | null> = {}, receipt = false) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('trial',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ne={'MATRIX_MEMORY_HINDSIGHT_DATABASE_URL':'postgresql://trial:synthetic@127.0.0.1/hindsight','MEMORY_TRIAL_LLM_MODEL':'synthetic-model','MEMORY_TRIAL_EMBEDDING_MODEL':'synthetic-embedding','MEMORY_TRIAL_EMBEDDING_DIMENSION':'1536','MEMORY_TRIAL_RERANK_MODEL':'synthetic-rerank','MEMORY_TRIAL_OPENAI_API_KEY':'synthetic-key','MEMORY_TRIAL_COHERE_API_KEY':'synthetic-key'}\ne.update(json.loads(sys.argv[2]))\nfor k in list(e):\n if e[k] is None: e.pop(k)\ntry: print(json.dumps(m.benchmark_receipt(e) if sys.argv[3] == 'receipt' else m.configuration(e)))\nexcept ValueError: print(json.dumps({'error':'invalid'}))`,
        modulePath,
        JSON.stringify(patch),
        receipt ? "receipt" : "configuration",
      ],
      { timeout: 10000, encoding: "utf8" },
    ),
  );
}
describe("native private memory trial configuration", () => {
  it("disables TLS probing only for the mandatory local trial database", () => {
    const [h] = render({ MATRIX_MEMORY_HINDSIGHT_DATABASE_URL: "postgresql://trial:synthetic@127.0.0.1/hindsight?application_name=trial" });
    const database = new URL(h.HINDSIGHT_API_DATABASE_URL);
    expect(database.searchParams.get("sslmode")).toBe("disable");
    expect(database.searchParams.get("application_name")).toBe("trial");
  });
  it("creates service-readable configuration despite a restrictive installer umask", () => {
    const mode = execFileSync("python3", ["-B", "-c", `import importlib.util,os,pathlib,stat,sys,tempfile\ns=importlib.util.spec_from_file_location('trial',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as root:\n os.umask(0o077)\n p=pathlib.Path(root)/'synthetic.conf'\n m.write_exclusive(p,'synthetic')\n print(oct(stat.S_IMODE(p.stat().st_mode)))`, modulePath], { timeout: 10000, encoding: "utf8" }).trim();
    expect(mode).toBe("0o640");
  });
  it("grants the service group runtime access before starting either engine", () => {
    const script = readFileSync(resolve("scripts/memory-trial/install.sh"), "utf8");
    expect(script).toContain('timeout 120 chgrp -R -h matrix "$trial_venv"');
    expect(script).toContain('timeout 120 chmod -R g+rX,g-w,o-rwx "$trial_venv"');
    expect(script.indexOf('chmod -R g+rX,g-w,o-rwx')).toBeLessThan(script.indexOf("systemctl enable --now"));
    expect(script).toContain('chmod 0640 "$trial_requirements_receipt" "$trial_reranking_receipt"');
  });
  it("bounds retain output and database pools for the trial model and VPS", () => {
    const [h] = render();
    expect(h.HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS).toBe("16000");
    expect(h.HINDSIGHT_API_RETAIN_CHUNK_SIZE).toBe("3000");
    expect(h.HINDSIGHT_API_DB_POOL_MIN_SIZE).toBe("2");
    expect(h.HINDSIGHT_API_DB_POOL_MAX_SIZE).toBe("10");
    expect(Number(h.HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS)).toBeGreaterThan(Number(h.HINDSIGHT_API_RETAIN_CHUNK_SIZE));
  });
  it("isolates an optional operator extraction endpoint and credential from embeddings", () => {
    const [defaults, defaultViking] = render();
    expect(defaults.HINDSIGHT_API_LLM_BASE_URL).toBe("https://api.openai.com/v1");
    expect(defaultViking.vlm.api_base).toBe("https://api.openai.com/v1");
    const [h, o] = render({ MEMORY_TRIAL_LLM_BASE_URL: "https://operator.example/v1", MEMORY_TRIAL_LLM_API_KEY: "synthetic-gateway-key" });
    expect(h.HINDSIGHT_API_LLM_BASE_URL).toBe("https://operator.example/v1");
    expect(h.HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-gateway-key");
    expect(o.vlm.api_base).toBe(h.HINDSIGHT_API_LLM_BASE_URL);
    expect(o.vlm.api_key).toBe(h.HINDSIGHT_API_LLM_API_KEY);
    expect(o.embedding.dense.api_base).toBe("https://api.openai.com/v1");
    expect(o.embedding.dense.api_key).toBe("synthetic-key");
    expect(h.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY).toBe("synthetic-key");
  });
  it("rejects credential leakage and unsafe operator endpoint syntax", () => {
    for (const base of ["http://operator.example/v1", "https://user:secret@operator.example/v1", "https://operator.example/v1?key=secret", "https://operator.example/v1#secret", "https://operator.example/v1\nEVIL=yes"]) {
      expect(render({ MEMORY_TRIAL_LLM_BASE_URL: base, MEMORY_TRIAL_LLM_API_KEY: "synthetic-gateway-key" })).toEqual({ error: "invalid" });
    }
    expect(render({ MEMORY_TRIAL_LLM_BASE_URL: "https://operator.example/v1" })).toEqual({ error: "invalid" });
    const receipt = render({ MEMORY_TRIAL_LLM_BASE_URL: "https://operator.example/v1", MEMORY_TRIAL_LLM_API_KEY: "synthetic-gateway-key" }, true);
    expect(receipt.models.extraction.endpoint).toBe("operator-configured");
    expect(JSON.stringify(receipt)).not.toContain("synthetic-gateway-key");
    expect(JSON.stringify(receipt)).not.toContain("operator.example");
  });
  it("defaults to supported no-model reranking without a Cohere credential", () => {
    const [h, o] = render({ MEMORY_TRIAL_COHERE_API_KEY: null, MEMORY_TRIAL_RERANK_MODEL: null });
    expect(h.HINDSIGHT_API_RERANKER_PROVIDER).toBe("rrf");
    expect(Object.keys(h).some(key => key.includes("RERANKER_COHERE"))).toBe(false);
    expect(o).not.toHaveProperty("rerank");
  });
  it("requires an explicit cloud reranking choice and its credential", () => {
    expect(render({ MEMORY_TRIAL_RERANKING: "cohere", MEMORY_TRIAL_COHERE_API_KEY: null })).toEqual({ error: "invalid" });
    const [h, o] = render({ MEMORY_TRIAL_RERANKING: "cohere" });
    expect(h.HINDSIGHT_API_RERANKER_PROVIDER).toBe("cohere");
    expect(o.rerank.log_payloads).toBe(false);
    expect(render({ MEMORY_TRIAL_RERANKING: "invented-switch" })).toEqual({ error: "invalid" });
  });
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
    expect(o).not.toHaveProperty("rerank");
  });
  it("records honest engine ranking differences without credentials", () => {
    const receipt = render({ MEMORY_TRIAL_COHERE_API_KEY: null, MEMORY_TRIAL_RERANK_MODEL: null }, true);
    expect(receipt.comparisonMode).toBe("without-model-reranking");
    expect(receipt.engines.hindsight).toMatchObject({ version: "0.10.2", reranking: { mode: "rrf_passthrough", cloudCalls: false, model: null } });
    expect(receipt.engines.openviking).toMatchObject({ version: "0.4.23", reranking: { mode: "vector_similarity", cloudCalls: false, model: null } });
    expect(receipt.rankingAlgorithmsEqual).toBe(false);
    expect(receipt.verification.installedRuntimeVerified).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("synthetic-key");
    expect(JSON.stringify(receipt)).not.toContain("synthetic@");
  });
  it("checks the installed pin before starting native services", () => {
    const script = readFileSync(resolve("scripts/memory-trial/install.sh"), "utf8");
    expect(script.indexOf("verify-reranking.py")).toBeGreaterThan(0);
    expect(script.indexOf("verify-reranking.py")).toBeLessThan(script.indexOf("systemctl enable --now"));
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
