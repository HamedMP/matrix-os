import { defineCommand } from "citty";
import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { formatCliSuccess } from "../output.js";
import { isDaemonRunning } from "../daemon-client.js";
import { resolveCliProfile } from "../profiles.js";
import { probeGatewayHealth } from "../gateway-health.js";

interface DoctorCheck {
  name: string;
  ok: boolean;
  code?: string;
  hint?: string;
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
      checks.push({ name: "profile", ok: false, code: "profile_not_found", hint: "Run `matrix profile ls`." });
    }

    let token: string | undefined;
    if (profile) {
      const auth = profile.token ? null : await loadProfileAuth(profile.name);
      token = profile.token ?? (auth && !isExpired(auth) ? auth.accessToken : undefined);
      checks.push(token
        ? { name: "auth", ok: true }
        : { name: "auth", ok: false, code: "not_authenticated", hint: "Run `matrix login`." });
    } else {
      checks.push({ name: "auth", ok: false, code: "profile_not_found", hint: "Run `matrix login`." });
    }

    checks.push((await isDaemonRunning())
      ? { name: "daemon", ok: true }
      : { name: "daemon", ok: false, code: "daemon_unavailable", hint: "Start sync with `matrix sync`." });

    if (profile) {
      try {
        const gateway = await probeGatewayHealth(profile.gatewayUrl, token);
        checks.push(gateway.reachable
          ? { name: "gateway", ok: true }
          : { name: "gateway", ok: false, code: "gateway_unavailable", hint: "Check the selected profile gateway URL." });
      } catch (_err: unknown) {
        checks.push({ name: "gateway", ok: false, code: "gateway_unavailable", hint: "Check the selected profile gateway URL." });
      }
    } else {
      checks.push({ name: "gateway", ok: false, code: "profile_not_found", hint: "Select a profile first." });
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
