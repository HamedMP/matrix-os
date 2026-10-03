import { bindNativeAccountMetadata } from "./native-account-metadata-binding.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { normalizeCodexNativeAccountMetadata, type CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

// Pinned Hermes native helpers (d337b736): read only the selected singleton,
// falling back to its native pool selector. Never import Codex CLI credentials,
// refresh tokens, clear quota cooldowns, or invoke a login from a Settings read.
// Only approved identity/allowance and private binding evidence reach the helper pipe. Credentials remain in
// the native process and the fixed official provider request headers.
export const HERMES_NATIVE_METADATA_SCRIPT = `
import json, logging, sys, contextlib, hashlib
class Discard:
    def write(self, text): return len(text)
    def flush(self): return None
logging.disable(logging.CRITICAL)
try:
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        from hermes_cli.auth import AuthError, _read_codex_tokens
        from hermes_cli.auth_codex import _pool_codex_access_token, _decode_jwt_claims
        from agent.codex_headers import codex_account_headers
        import httpx
    def selected():
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            try:
                return (_read_codex_tokens(_lock=False).get("tokens") or {})
            except AuthError:
                token = _pool_codex_access_token()
                return {"access_token": token} if token else {}
    tokens = selected()
    token = tokens.get("access_token")
    if not token:
        print("null")
        sys.exit(0)
    binding = hashlib.sha256(token.encode()).hexdigest()
    if "--verify-only" in sys.argv:
        print(json.dumps({"binding": binding}))
        sys.exit(0)
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        claims = _decode_jwt_claims(tokens.get("id_token") or token) or {}
        access_claims = _decode_jwt_claims(token) or {}
    if claims.get("sub") and access_claims.get("sub") and claims["sub"] != access_claims["sub"]:
        print("null")
        sys.exit(0)
    profile = claims.get("https://api.openai.com/profile") or {}
    email = claims.get("email") or profile.get("email")
    if not isinstance(email, str):
        print("null")
        sys.exit(0)
    result = {"account": {"type": "chatgpt", "email": email}}
    try:
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            headers = {"Authorization": "Bearer " + token, "Accept": "application/json", "User-Agent": "codex-cli", **codex_account_headers(token)}
            with httpx.Client(timeout=3.0, follow_redirects=False) as client:
                with client.stream("GET", "https://chatgpt.com/backend-api/wham/usage", headers=headers) as response:
                    response.raise_for_status()
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > 65536:
                            raise ValueError("response limit")
                    raw = json.loads(body)
            window = (raw.get("rate_limit") or {}).get("primary_window") or {}
            result["limits"] = {"rateLimits": {"primary": {"usedPercent": window.get("used_percent"), "windowDurationMins": (window.get("limit_window_seconds") or 0) / 60, "resetsAt": window.get("reset_at")}}}
    except Exception as error:
        print("Native allowance unavailable: " + type(error).__name__, file=sys.stderr)
    if selected().get("access_token") != token:
        print("null")
    else:
        result["binding"] = binding
        print(json.dumps(result, ensure_ascii=True))
except Exception as error:
    print("Native account metadata unavailable: " + type(error).__name__, file=sys.stderr)
    print("null")
`;

type Execute = typeof execFile;
export function createHermesNativeAccountMetadataReader(input: { homePath: string; now?: () => Date; execute?: Execute }): () => Promise<CodexNativeAccountMetadata | null> {
  const homePath = resolve(input.homePath);
  const installation = join(homePath, ".hermes/hermes-agent");
  let pending: Promise<CodexNativeAccountMetadata | null> | null = null;
  let lastStartedAt = -Infinity;
  let verification: Promise<string | null> | null = null;
  return () => {
    if (pending) return pending;
    if (verification) return Promise.resolve(null);
    const now = (input.now ?? (() => new Date()))();
    const waitMs = Math.max(0, 5000 - (now.getTime() - lastStartedAt));
    if (waitMs > 0) return Promise.resolve(null);
    const environment = buildAgentRuntimeEnvironment(homePath);
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) => ["HOME", "MATRIX_HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "MATRIX_NODE_PREFIX"].includes(key)));
    pending = (async () => {
      try {
        lastStartedAt = (input.now ?? (() => new Date()))().getTime();
        const { stdout } = await promisify(input.execute ?? execFile)(join(installation, "venv/bin/python"), ["-c", HERMES_NATIVE_METADATA_SCRIPT], {
          cwd: installation, env: { ...env, HERMES_HOME: join(homePath, ".hermes") }, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true,
        });
        const raw = JSON.parse(String(stdout)) as { account?: unknown; limits?: unknown; binding?: unknown } | null;
        if (!raw) return null;
        const value = normalizeCodexNativeAccountMetadata({ account: raw.account }, raw.limits, (input.now ?? (() => new Date()))());
        if (!value || typeof raw.binding !== "string" || !/^[a-f0-9]{64}$/.test(raw.binding)) return value;
        const proof = raw.binding;
        return bindNativeAccountMetadata(value, async () => {
          if (pending) return false;
          if (!verification) verification = (async () => {
            const { stdout: current } = await promisify(input.execute ?? execFile)(join(installation, "venv/bin/python"), ["-c", HERMES_NATIVE_METADATA_SCRIPT, "--verify-only"], {
              cwd: installation, env: { ...env, HERMES_HOME: join(homePath, ".hermes") }, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true,
            });
            const selected = JSON.parse(String(current)) as { binding?: unknown } | null;
            return typeof selected?.binding === "string" && /^[a-f0-9]{64}$/.test(selected.binding) ? selected.binding : null;
          })().finally(() => { verification = null; });
          return await verification === proof;
        });
      } catch (error: unknown) {
        console.warn("[provider-settings] Native account metadata unavailable:", error instanceof Error ? error.name : "UnknownError");
        return null;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}
