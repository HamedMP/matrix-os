import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOOTSTRAP,
  NETWORKS,
  TEST_INPUTS,
  listSecretValues,
  makeStateDir,
  mode,
  readSecret,
  readYaml,
  removeDir,
  runBootstrap,
  type BootstrapRun,
} from "./helpers.js";

interface HomeserverConfig {
  server_name: string;
  public_baseurl: string;
  listeners: { port: number; resources: { names: string[] }[] }[];
  federation_domain_whitelist: string[];
  enable_registration: boolean;
  allow_guest_access: boolean;
  allow_public_rooms_over_federation: boolean;
  allow_public_rooms_without_auth: boolean;
  room_list_publication_rules: { action: string }[];
  enable_room_list_search: boolean;
  trusted_key_servers: unknown[];
  retention: {
    enabled: boolean;
    default_policy: { max_lifetime: string };
    allowed_lifetime_max: string;
    purge_jobs: { interval: string }[];
  };
  max_upload_size: string;
  media_retention: { local_media_lifetime: string; remote_media_lifetime: string };
  url_preview_enabled: boolean;
  user_directory: { enabled: boolean };
  require_auth_for_profile_requests: boolean;
  limit_profile_requests_to_users_who_share_rooms: boolean;
  presence: { enabled: boolean };
  app_service_config_files: string[];
  rc_message: { per_second: number; burst_count: number };
  database: { name: string; args: { user: string; dbname: string; host: string; password: string } };
  registration_shared_secret: string;
  macaroon_secret_key: string;
}

interface Registration {
  id: string;
  url: string | null;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: boolean;
  namespaces: { users: { regex: string; exclusive: boolean }[] };
}

interface BridgeConfig {
  network: Record<string, unknown>;
  bridge: {
    split_portals: boolean;
    relay: { enabled: boolean; default_relays: unknown[] };
    permissions: Record<string, unknown>;
    cleanup_on_logout: { enabled: boolean; manual: Record<string, string> };
  };
  database: { type: string; uri: string };
  homeserver: { address: string; domain: string };
  appservice: { address: string; hostname: string; port: number; id: string; as_token: string; hs_token: string; bot: { username: string } };
  matrix: { federate_rooms: boolean };
  provisioning: { shared_secret: string; allow_matrix_auth: boolean; debug_endpoints: boolean; fail_on_webauthn: boolean };
  double_puppet: { secrets: Record<string, string>; allow_discovery: boolean; servers: Record<string, string> };
  encryption: { allow: boolean; default: boolean; pickle_key: string };
  backfill: { enabled: boolean; max_initial_messages: number; max_catchup_messages: number };
  logging: { min_level: string; writers: { type: string }[] };
}

const SERVER = TEST_INPUTS.MBH_SERVER_NAME;
const PLATFORM_KEYS = [
  "MESSAGING_BRIDGE_HOST_URL",
  "MESSAGING_BRIDGE_SERVER_NAME",
  "MESSAGING_BRIDGE_ADMIN_TOKEN",
  "MESSAGING_BRIDGE_GATE_SECRET",
  "MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN",
  "MESSAGING_BRIDGE_USER_ID_KEY",
  "MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP",
  "MESSAGING_BRIDGE_PROVISIONING_SECRET_TELEGRAM",
  "MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN",
];

describe("bootstrap.sh render", () => {
  let state: string;
  let first: BootstrapRun;

  beforeAll(() => {
    state = makeStateDir();
    first = runBootstrap(state);
  });
  afterAll(() => removeDir(state));

  it("succeeds in render-only mode", () => {
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
  });

  it("never echoes a secret to stdout or stderr", () => {
    const secrets = listSecretValues(state);
    expect(secrets.length).toBeGreaterThan(20);
    for (const secret of secrets) {
      expect(first.stdout).not.toContain(secret);
      expect(first.stderr).not.toContain(secret);
    }
    expect(first.stdout).not.toContain(TEST_INPUTS.MBH_TELEGRAM_API_HASH);
  });

  it("writes secrets and configs with owner-only permissions", () => {
    expect(mode(state)).toBe(0o700);
    expect(mode(join(state, "secrets"))).toBe(0o700);
    for (const name of readdirSync(join(state, "secrets"))) {
      expect(mode(join(state, "secrets", name)), name).toBe(0o600);
    }
    const rendered = [
      "synapse/homeserver.yaml",
      "synapse/appservices/doublepuppet.yaml",
      "caddy/Caddyfile",
      ...NETWORKS.flatMap((network) => [
        `bridges/${network}/config.yaml`,
        `bridges/${network}/registration.yaml`,
        `synapse/appservices/${network}.yaml`,
      ]),
    ];
    for (const path of rendered) {
      expect(mode(join(state, path)), path).toBe(0o600);
    }
    for (const dir of ["synapse", "synapse/appservices", "caddy", "bridges", ...NETWORKS.map((n) => `bridges/${n}`)]) {
      expect(mode(join(state, dir)), dir).toBe(0o700);
    }
  });

  it("does not write the platform env block before an admin token exists", () => {
    expect(existsSync(join(state, "platform.env"))).toBe(false);
  });

  it("closes the homeserver: no federation, no registration, no public directory", () => {
    const hs = readYaml<HomeserverConfig>(join(state, "synapse/homeserver.yaml"));
    expect(hs.server_name).toBe(SERVER);
    expect(hs.public_baseurl).toBe(`https://${TEST_INPUTS.MBH_PUBLIC_HOSTNAME}/`);
    expect(hs.federation_domain_whitelist).toEqual([]);
    expect(hs.trusted_key_servers).toEqual([]);
    for (const listener of hs.listeners) {
      const names = listener.resources.flatMap((resource) => resource.names);
      expect(names).not.toContain("federation");
      expect(names).not.toContain("keys");
    }
    expect(hs.enable_registration).toBe(false);
    expect(hs.allow_guest_access).toBe(false);
    expect(hs.allow_public_rooms_over_federation).toBe(false);
    expect(hs.allow_public_rooms_without_auth).toBe(false);
    expect(hs.room_list_publication_rules).toEqual([{ action: "deny" }]);
    expect(hs.enable_room_list_search).toBe(false);
    expect(hs.user_directory.enabled).toBe(false);
    expect(hs.require_auth_for_profile_requests).toBe(true);
    expect(hs.limit_profile_requests_to_users_who_share_rooms).toBe(true);
    expect(hs.presence.enabled).toBe(false);
    expect(hs.url_preview_enabled).toBe(false);
  });

  it("purges messages after 7 days and caps media", () => {
    const hs = readYaml<HomeserverConfig>(join(state, "synapse/homeserver.yaml"));
    expect(hs.retention.enabled).toBe(true);
    expect(hs.retention.default_policy.max_lifetime).toBe("7d");
    expect(hs.retention.allowed_lifetime_max).toBe("7d");
    expect(hs.retention.purge_jobs.length).toBeGreaterThan(0);
    expect(hs.max_upload_size).toBe("50M");
    expect(hs.media_retention.local_media_lifetime).toBe("7d");
    expect(hs.media_retention.remote_media_lifetime).toBe("1d");
  });

  it("wires the homeserver to its own database and all four appservice registrations", () => {
    const hs = readYaml<HomeserverConfig>(join(state, "synapse/homeserver.yaml"));
    expect(hs.database.name).toBe("psycopg2");
    expect(hs.database.args).toMatchObject({ user: "synapse", dbname: "synapse", host: "postgres" });
    expect(hs.database.args.password).toBe(readSecret(state, "db-synapse-password"));
    expect(hs.registration_shared_secret).toBe(readSecret(state, "synapse-registration-shared-secret"));
    expect(hs.app_service_config_files.sort()).toEqual(
      ["doublepuppet", ...NETWORKS].map((name) => `/data/appservices/${name}.yaml`).sort(),
    );
    expect(hs.rc_message.burst_count).toBeGreaterThanOrEqual(30);
  });

  it.each(NETWORKS)("isolates %s users: split portals, no relay, no admins, own database", (network) => {
    const config = readYaml<BridgeConfig>(join(state, `bridges/${network}/config.yaml`));
    expect(config.bridge.split_portals).toBe(true);
    expect(config.bridge.relay.enabled).toBe(false);
    expect(config.bridge.relay.default_relays).toEqual([]);
    expect(config.bridge.permissions["*"]).toBe("block");
    expect(config.bridge.permissions[SERVER]).toMatchObject({ login: true, double_puppet: true, admin: false, manage_relay: false, max_logins: 1 });
    expect(Object.keys(config.bridge.permissions).filter((key) => key.startsWith("@"))).toEqual([]);
    expect(Object.values(config.bridge.permissions)).not.toContain("admin");
    expect(config.matrix.federate_rooms).toBe(false);
    expect(config.encryption.allow).toBe(false);
    expect(config.encryption.default).toBe(false);
    expect(config.database.type).toBe("postgres");
    expect(config.database.uri).toBe(
      `postgres://${network}:${readSecret(state, `db-${network}-password`)}@postgres:5432/${network}?sslmode=disable`,
    );
    expect(config.homeserver).toMatchObject({ address: "http://synapse:8008", domain: SERVER });
    expect(config.bridge.cleanup_on_logout.enabled).toBe(true);
    expect(config.bridge.cleanup_on_logout.manual.private).toBe("delete");
    expect(config.backfill.enabled).toBe(true);
    expect(config.backfill.max_initial_messages).toBeLessThanOrEqual(100);
    expect(config.logging.writers.map((writer) => writer.type)).toEqual(["stdout"]);
  });

  it.each(NETWORKS)("enables only shared-secret provisioning for %s", (network) => {
    const config = readYaml<BridgeConfig>(join(state, `bridges/${network}/config.yaml`));
    expect(config.provisioning.shared_secret).toBe(readSecret(state, `${network}-provisioning-secret`));
    expect(config.provisioning.shared_secret.length).toBeGreaterThanOrEqual(32);
    expect(config.provisioning.allow_matrix_auth).toBe(false);
    expect(config.provisioning.debug_endpoints).toBe(false);
    expect(config.provisioning.fail_on_webauthn).toBe(true);
  });

  it.each(NETWORKS)("double puppets %s through the scoped appservice token", (network) => {
    const config = readYaml<BridgeConfig>(join(state, `bridges/${network}/config.yaml`));
    expect(config.double_puppet.secrets).toEqual({ [SERVER]: `as_token:${readSecret(state, "doublepuppet-as-token")}` });
    expect(config.double_puppet.allow_discovery).toBe(false);
    expect(config.double_puppet.servers).toEqual({});
  });

  it.each(NETWORKS)("registers %s with matching tokens and exclusive namespaces", (network) => {
    const config = readYaml<BridgeConfig>(join(state, `bridges/${network}/config.yaml`));
    const synapseCopy = readYaml<Registration>(join(state, `synapse/appservices/${network}.yaml`));
    const bridgeCopy = readYaml<Registration>(join(state, `bridges/${network}/registration.yaml`));
    expect(bridgeCopy).toEqual(synapseCopy);
    expect(synapseCopy.id).toBe(network);
    expect(synapseCopy.url).toBe(config.appservice.address);
    expect(config.appservice.address).toBe(`http://mautrix-${network}:${config.appservice.port}`);
    expect(config.appservice.hostname).toBe("0.0.0.0");
    expect(synapseCopy.as_token).toBe(config.appservice.as_token);
    expect(synapseCopy.hs_token).toBe(config.appservice.hs_token);
    expect(synapseCopy.as_token).toBe(readSecret(state, `${network}-as-token`));
    expect(synapseCopy.as_token).not.toBe(synapseCopy.hs_token);
    expect(synapseCopy.rate_limited).toBe(false);
    const escaped = SERVER.replaceAll(".", "\\.");
    expect(synapseCopy.namespaces.users).toEqual([
      { regex: `^@${network}bot:${escaped}$`, exclusive: true },
      { regex: `^@${network}_.*:${escaped}$`, exclusive: true },
    ]);
  });

  it("scopes the double-puppet appservice to owner users only", () => {
    const registration = readYaml<Registration>(join(state, "synapse/appservices/doublepuppet.yaml"));
    expect(registration.url).toBeNull();
    expect(registration.rate_limited).toBe(false);
    expect(registration.namespaces.users).toEqual([
      { regex: `^@mxo_[a-z0-9]+:${SERVER.replaceAll(".", "\\.")}$`, exclusive: false },
    ]);
  });

  it("uses distinct tokens for every appservice", () => {
    const tokens = [...NETWORKS, "doublepuppet"].flatMap((name) => [
      readSecret(state, `${name}-as-token`),
      readSecret(state, `${name}-hs-token`),
    ]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("passes the Telegram API credentials into the Telegram bridge only", () => {
    const telegram = readYaml<BridgeConfig>(join(state, "bridges/telegram/config.yaml"));
    expect(telegram.network.api_id).toBe(Number(TEST_INPUTS.MBH_TELEGRAM_API_ID));
    expect(telegram.network.api_hash).toBe(TEST_INPUTS.MBH_TELEGRAM_API_HASH);
    for (const network of ["whatsapp", "linkedin"] as const) {
      expect(readFileSync(join(state, `bridges/${network}/config.yaml`), "utf8")).not.toContain(TEST_INPUTS.MBH_TELEGRAM_API_HASH);
    }
  });

  it("re-running keeps every secret and does not need the inputs again", () => {
    const before = Object.fromEntries(readdirSync(join(state, "secrets")).map((name) => [name, readSecret(state, name)]));
    const rerun = runBootstrap(state, { MBH_TELEGRAM_API_ID: undefined, MBH_TELEGRAM_API_HASH: undefined });
    expect(rerun.stderr).toBe("");
    expect(rerun.status).toBe(0);
    const after = Object.fromEntries(readdirSync(join(state, "secrets")).map((name) => [name, readSecret(state, name)]));
    expect(after).toEqual(before);
  });
});

describe("bootstrap.sh secret handling", () => {
  it("never overwrites an existing secret file and renders configs from it", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      const custom = "f".repeat(64);
      writeFileSync(join(state, "secrets", "whatsapp-provisioning-secret"), `${custom}\n`, { mode: 0o600 });
      const rerun = runBootstrap(state);
      expect(rerun.status).toBe(0);
      expect(readSecret(state, "whatsapp-provisioning-secret")).toBe(custom);
      const config = readYaml<BridgeConfig>(join(state, "bridges/whatsapp/config.yaml"));
      expect(config.provisioning.shared_secret).toBe(custom);
      expect(rerun.stdout).not.toContain(custom);
    } finally {
      removeDir(state);
    }
  });

  it("writes the platform env block to a root-only file once the admin token exists", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      const adminToken = "syt_admin_" + "a".repeat(40);
      writeFileSync(join(state, "secrets", "admin-access-token"), `${adminToken}\n`, { mode: 0o600, flag: "wx" });
      const rerun = runBootstrap(state);
      expect(rerun.status).toBe(0);
      const envPath = join(state, "platform.env");
      expect(mode(envPath)).toBe(0o600);
      const env = Object.fromEntries(
        readFileSync(envPath, "utf8")
          .split("\n")
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      for (const key of PLATFORM_KEYS) expect(env[key], key).toBeTruthy();
      expect(env.MESSAGING_BRIDGE_HOST_URL).toBe(`https://${TEST_INPUTS.MBH_PUBLIC_HOSTNAME}`);
      expect(env.MESSAGING_BRIDGE_SERVER_NAME).toBe(SERVER);
      expect(env.MESSAGING_BRIDGE_ADMIN_TOKEN).toBe(adminToken);
      expect(env.MESSAGING_BRIDGE_GATE_SECRET).toBe(readSecret(state, "gate-secret"));
      expect(env.MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN).toBe(readSecret(state, "doublepuppet-as-token"));
      expect(env.MESSAGING_BRIDGE_USER_ID_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(env.MESSAGING_BRIDGE_USER_ID_KEY).toBe(readSecret(state, "platform-user-id-key"));
      for (const network of NETWORKS) {
        expect(env[`MESSAGING_BRIDGE_PROVISIONING_SECRET_${network.toUpperCase()}`]).toBe(
          readSecret(state, `${network}-provisioning-secret`),
        );
      }
      expect(rerun.stdout).not.toContain(adminToken);
      expect(rerun.stdout).toContain(envPath);
    } finally {
      removeDir(state);
    }
  });

  it("refuses to start without the required inputs and creates no secrets", () => {
    const state = makeStateDir();
    try {
      const run = runBootstrap(state, { MBH_PUBLIC_HOSTNAME: undefined });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("MBH_PUBLIC_HOSTNAME");
      expect(existsSync(join(state, "secrets"))).toBe(false);
    } finally {
      removeDir(state);
    }
  });

  it("rejects malformed inputs before touching the state directory", () => {
    for (const bad of [
      { MBH_PUBLIC_HOSTNAME: "bridge.example;rm -rf /" },
      { MBH_TELEGRAM_API_ID: "12ab" },
      { MBH_TELEGRAM_API_HASH: "not-a-hash" },
      { MBH_ACME_EMAIL: "no-at-sign" },
    ]) {
      const state = makeStateDir();
      try {
        const run = runBootstrap(state, bad);
        expect(run.status, JSON.stringify(bad)).not.toBe(0);
        expect(existsSync(join(state, "secrets")), JSON.stringify(bad)).toBe(false);
      } finally {
        removeDir(state);
      }
    }
  });

  it("is a strict shell script that never traces commands", () => {
    const script = readFileSync(BOOTSTRAP, "utf8");
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(script).toContain("set -eu");
    expect(script).toContain("umask 077");
    expect(script).not.toMatch(/set -[a-z]*x/);
    expect(statSync(BOOTSTRAP).mode & 0o111).not.toBe(0);
  });
});

describe("bootstrap.sh Telegram credential replacement", () => {
  const NEW_ID = "7654321";
  const NEW_HASH = "fedcba9876543210fedcba9876543210";

  it("refuses Telegram credentials that differ from the saved pair and changes nothing", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      const before = readFileSync(join(state, "bridges/telegram/config.yaml"), "utf8");
      for (const input of [{ MBH_TELEGRAM_API_ID: NEW_ID }, { MBH_TELEGRAM_API_HASH: NEW_HASH }]) {
        const run = runBootstrap(state, input);
        expect(run.status, JSON.stringify(input)).not.toBe(0);
        expect(run.stderr).toContain("secrets/telegram-api-id");
        expect(run.stderr).not.toContain(NEW_HASH);
      }
      expect(readSecret(state, "telegram-api-id")).toBe(TEST_INPUTS.MBH_TELEGRAM_API_ID);
      expect(readSecret(state, "telegram-api-hash")).toBe(TEST_INPUTS.MBH_TELEGRAM_API_HASH);
      expect(readFileSync(join(state, "bridges/telegram/config.yaml"), "utf8")).toBe(before);
    } finally {
      removeDir(state);
    }
  });

  it("replaces both credentials after both secrets are deleted and marks only the Telegram bridge for restart", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      // Simulate a host whose services already applied the first render.
      rmSync(join(state, "pending-restart"), { recursive: true, force: true });
      const others = Object.fromEntries(
        readdirSync(join(state, "secrets"))
          .filter((name) => !name.startsWith("telegram-api-"))
          .map((name) => [name, readSecret(state, name)]),
      );
      unlinkSync(join(state, "secrets", "telegram-api-id"));
      unlinkSync(join(state, "secrets", "telegram-api-hash"));

      const run = runBootstrap(state, { MBH_TELEGRAM_API_ID: NEW_ID, MBH_TELEGRAM_API_HASH: NEW_HASH });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain(NEW_HASH);

      const telegram = readYaml<BridgeConfig>(join(state, "bridges/telegram/config.yaml"));
      expect(telegram.network.api_id).toBe(Number(NEW_ID));
      expect(telegram.network.api_hash).toBe(NEW_HASH);
      expect(readSecret(state, "telegram-api-id")).toBe(NEW_ID);
      expect(readSecret(state, "telegram-api-hash")).toBe(NEW_HASH);
      for (const [name, value] of Object.entries(others)) expect(readSecret(state, name), name).toBe(value);
      expect(readdirSync(join(state, "pending-restart"))).toEqual(["mautrix-telegram"]);

      // A later run without inputs keeps the replaced pair.
      const rerun = runBootstrap(state, { MBH_TELEGRAM_API_ID: undefined, MBH_TELEGRAM_API_HASH: undefined });
      expect(rerun.status).toBe(0);
      expect(readYaml<BridgeConfig>(join(state, "bridges/telegram/config.yaml")).network.api_hash).toBe(NEW_HASH);
    } finally {
      removeDir(state);
    }
  });
});

describe("bootstrap.sh pending restarts", () => {
  function fakeDocker(dir: string): string {
    const bin = join(dir, "fake-bin");
    mkdirSync(bin);
    const script = [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$*" in',
      '  *" ps -q "*) [ -n "${FAKE_DOCKER_EXISTING:-}" ] && printf \'cid\\n\' ;;',
      '  inspect*) printf \'running\\n\' ;;',
      '  *" restart "*) [ -z "${FAKE_DOCKER_FAIL_RESTART:-}" ] || exit 1 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(join(bin, "docker"), script);
    chmodSync(join(bin, "docker"), 0o755);
    return bin;
  }

  function startService(state: string, service: string, env: Record<string, string>) {
    const bin = fakeDocker(state);
    const log = join(state, "docker.log");
    const result = spawnSync("bash", ["-c", `. "$1"; start_service "$2"`, "bash", BOOTSTRAP, service], {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MBH_STATE_DIR: state, FAKE_DOCKER_LOG: log, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    rmSync(bin, { recursive: true, force: true });
    return { status: result.status, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  }

  it("restarts an existing service whose config change is still pending from an earlier run, then clears the marker", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      expect(existsSync(join(state, "pending-restart", "mautrix-telegram"))).toBe(true);
      const run = startService(state, "mautrix-telegram", { FAKE_DOCKER_EXISTING: "1" });
      expect(run.status).toBe(0);
      expect(run.calls).toMatch(/ restart mautrix-telegram/);
      expect(existsSync(join(state, "pending-restart", "mautrix-telegram"))).toBe(false);

      const again = startService(state, "mautrix-telegram", { FAKE_DOCKER_EXISTING: "1" });
      expect(again.status).toBe(0);
      expect(again.calls.split("\n").filter((line) => line.includes(" restart ")).length).toBe(1);
    } finally {
      removeDir(state);
    }
  });

  it("keeps the marker when the restart fails so the next run retries it", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      const run = startService(state, "synapse", { FAKE_DOCKER_EXISTING: "1", FAKE_DOCKER_FAIL_RESTART: "1" });
      expect(run.status).not.toBe(0);
      expect(existsSync(join(state, "pending-restart", "synapse"))).toBe(true);
    } finally {
      removeDir(state);
    }
  });

  it("does not restart a newly created container and clears its marker", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      const run = startService(state, "caddy", {});
      expect(run.status).toBe(0);
      expect(run.calls).toMatch(/ up -d caddy/);
      expect(run.calls).not.toMatch(/ restart /);
      expect(existsSync(join(state, "pending-restart", "caddy"))).toBe(false);
    } finally {
      removeDir(state);
    }
  });
});

describe("bootstrap.sh ownership of unchanged configs", () => {
  it("fixes owner and mode of configs a non-root render left behind when the content is unchanged", () => {
    const state = makeStateDir();
    try {
      expect(runBootstrap(state).status).toBe(0);
      chmodSync(join(state, "synapse/homeserver.yaml"), 0o644);

      // Second run as "root": a fake id reports uid 0 and a fake chown records its calls.
      const bin = join(state, "fake-root-bin");
      mkdirSync(bin);
      const log = join(state, "chown.log");
      writeFileSync(join(bin, "id"), '#!/usr/bin/env bash\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n');
      writeFileSync(join(bin, "chown"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
      chmodSync(join(bin, "id"), 0o755);
      chmodSync(join(bin, "chown"), 0o755);
      const rerun = runBootstrap(state, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
      expect(rerun.status).toBe(0);

      const calls = readFileSync(log, "utf8").split("\n");
      expect(calls).toContain(`991:991 ${join(state, "synapse/homeserver.yaml")}`);
      expect(calls).toContain(`1337:1337 ${join(state, "bridges/telegram/config.yaml")}`);
      expect(calls).toContain(`70:70 ${join(state, "postgres/superuser-password")}`);
      expect(mode(join(state, "synapse/homeserver.yaml"))).toBe(0o600);
    } finally {
      removeDir(state);
    }
  });
});
