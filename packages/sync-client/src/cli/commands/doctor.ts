import { defineCommand } from "citty";
import { formatCliSuccess } from "../output.js";
import { isDaemonRunning } from "../daemon-client.js";
import { resolveCliProfile } from "../profiles.js";
import { probeGatewayHealth } from "../gateway-health.js";
import { resolveCliAuthStatus } from "../auth-state.js";

interface DoctorCheck {
  name: string;
  ok: boolean;
  code?: string;
  hint?: string;
}

const SAFE_SHELL_HEALTH_CODES = new Set([
  "ok",
  "zellij_failed",
  "shell_backend_unavailable",
  "auth_expired",
]);

async function probeShellBackendHealth(gatewayUrl: string, token?: string): Promise<{ ok: boolean; code: string }> {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/api/terminal/health`, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    return { ok: false, code: "auth_expired" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError) && !(err instanceof TypeError)) {
      throw err;
    }
  }
  const code =
    typeof body === "object" &&
    body !== null &&
    "shell" in body &&
    typeof (body as { shell?: { code?: unknown } }).shell?.code === "string" &&
    SAFE_SHELL_HEALTH_CODES.has((body as { shell: { code: string } }).shell.code)
      ? (body as { shell: { code: string } }).shell.code
      : res.ok
        ? "ok"
        : "zellij_failed";
  return { ok: res.ok && code === "ok", code };
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose Matrix OS CLI and shell issues",
  },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    const checks: DoctorCheck[] = [];
    let profile: Awaited<ReturnType<typeof resolveCliProfile>> | null = null;

    try {
      profile = await resolveCliProfile(args);
      checks.push({ name: "profile", ok: true });
    } catch (_err: unknown) {
      checks.push({ name: "profile", ok: false, code: "profile_not_found", hint: "Run `mos profile ls`." });
    }

    let token: string | undefined;
    if (profile) {
      const authStatus = await resolveCliAuthStatus(profile);
      token = authStatus.status === "authenticated" ? authStatus.token : undefined;
      checks.push(authStatus.status === "authenticated"
        ? { name: "auth", ok: true }
        : authStatus.status === "expired"
          ? {
              name: "auth",
              ok: false,
              code: "auth_expired",
              hint: `Run \`mos login --profile ${profile.name}\` to refresh.`,
            }
          : { name: "auth", ok: false, code: "not_authenticated", hint: "Run `mos login`." });
    } else {
      checks.push({ name: "auth", ok: false, code: "profile_not_found", hint: "Run `mos login`." });
    }

    checks.push((await isDaemonRunning())
      ? { name: "daemon", ok: true }
      : { name: "daemon", ok: false, code: "daemon_unavailable", hint: "Start sync with `mos sync`." });

    if (profile) {
      let gatewayReachable = false;
      try {
        const gateway = await probeGatewayHealth(profile.gatewayUrl, token);
        gatewayReachable = gateway.reachable;
        checks.push(gateway.reachable
          ? { name: "gateway", ok: true }
          : { name: "gateway", ok: false, code: "gateway_unavailable", hint: "Check the selected profile gateway URL." });
      } catch (_err: unknown) {
        checks.push({ name: "gateway", ok: false, code: "gateway_unavailable", hint: "Check the selected profile gateway URL." });
      }
      if (gatewayReachable) {
        try {
          const shell = await probeShellBackendHealth(profile.gatewayUrl, token);
          checks.push(shell.ok
            ? { name: "shell-backend", ok: true }
            : {
                name: "shell-backend",
                ok: false,
                code: shell.code === "ok" ? "zellij_failed" : shell.code,
                hint: shell.code === "auth_expired"
                  ? `Run \`mos login --profile ${profile.name}\` to refresh.`
                  : `Run \`mos doctor --profile ${profile.name}\`; managed VPSes may need the latest host bundle deployed.`,
              });
        } catch (_err: unknown) {
          checks.push({
            name: "shell-backend",
            ok: false,
            code: "gateway_unreachable",
            hint: "Gateway reachable check passed, but shell health did not respond. Try again or verify the host bundle.",
          });
        }
      } else {
        checks.push({ name: "shell-backend", ok: false, code: "gateway_unavailable", hint: "Fix gateway reachability first." });
      }
    } else {
      checks.push({ name: "gateway", ok: false, code: "profile_not_found", hint: "Select a profile first." });
      checks.push({ name: "shell-backend", ok: false, code: "profile_not_found", hint: "Select a profile first." });
    }

    checks.push({ name: "protocol", ok: true });

    if (json) {
      console.log(formatCliSuccess({ checks }));
      return;
    }
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}${check.hint ? ` - ${check.hint}` : ""}`);
    }
  },
});
