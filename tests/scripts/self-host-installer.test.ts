import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("self-host server installer", () => {
  it("keeps the website-hosted installer identical to the source installer", () => {
    const source = readFileSync(join(root, "scripts/install-server.sh"), "utf8");
    const website = readFileSync(join(root, "www/public/install-server.sh"), "utf8");

    expect(website).toBe(source);
    expect(statSync(join(root, "scripts/install-server.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(root, "www/public/install-server.sh")).mode & 0o111).not.toBe(0);
  });

  it("installs from a verified host bundle and writes standalone self-host configuration", () => {
    const script = readFileSync(join(root, "scripts/install-server.sh"), "utf8");

    expect(script).toContain('DEFAULT_CHANNEL="${MATRIX_CHANNEL:-dev}"');
    expect(script).toContain("https://app.matrix-os.com/system-bundles/${DEFAULT_CHANNEL}");
    expect(script).toContain("MATRIX_HOST_BUNDLE_URL");
    expect(script).toContain("${MATRIX_HOST_BUNDLE_URL}.sha256");
    expect(script).toContain("preflight_bundle_url");
    expect(script).toContain("signed R2 GET URL");
    expect(script).toContain("curl --fail --silent --show-error --head");
    expect(script).toContain("host bundle is not reachable");
    expect(script).toContain("Host bundle is reachable");
    expect(script).toContain("sha256sum \"$tmp_bundle\"");
    expect(script).toContain("[ \"$expected\" = \"$actual\" ] || fail \"bundle checksum mismatch\"");
    expect(script).toContain("tar -xzf \"$tmp_bundle\" -C /opt/matrix");
    expect(script).toContain("MATRIX_SELF_HOSTED=1");
    expect(script).toContain("MATRIX_AUTH_TOKEN=${auth_token}");
    expect(script).toContain("MATRIX_CODE_PROXY_TOKEN=${code_token}");
    expect(script).toContain("DATABASE_URL=postgresql://matrix:${postgres_password}@127.0.0.1:5432/matrix");
    expect(script).toContain("NEXT_PUBLIC_GATEWAY_WS=/ws");
    expect(script).toContain("validate_config");
    expect(script).toContain("MATRIX_HOST_BUNDLE_URL must be https");
    expect(script).toContain("MATRIX_HOME must stay under /home/matrix");
    expect(script).toContain("[ \"${#MATRIX_DOMAIN}\" -le 253 ]");
    expect(script).toContain("[[ \"$MATRIX_DOMAIN\" =~ ^[A-Za-z0-9]");
    expect(script).toContain("openssl rand -hex 32");
    expect(script).toContain("read_env_value /opt/matrix/env/host.env MATRIX_AUTH_TOKEN || random_secret");
    expect(script).toContain("read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN || random_secret");
    expect(script).toContain("read_env_value /opt/matrix/env/postgres.env POSTGRES_PASSWORD || random_secret");
    expect(script).toContain("cleanup_install_tmp");
    expect(script).toContain("trap cleanup_install_tmp EXIT");
  });

  it("prepares the bundled Node runtime for owner-user agent installs", () => {
    const script = readFileSync(join(root, "scripts/install-server.sh"), "utf8");

    expect(script).toContain("prepare_runtime_permissions");
    expect(script).toContain("Preparing runtime permissions");
    expect(script).toContain("[ -d /opt/matrix/runtime/node ]");
    expect(script).toContain("chown -R root:matrix /opt/matrix/runtime/node");
    expect(script).toContain("chmod -R g+rwX /opt/matrix/runtime/node");
    expect(script).toContain('find /opt/matrix/runtime/node -type d -exec chmod g+s {} +');
    expect(script).toContain("Runtime permissions ready");
    expect(script).toContain("sudo -iu matrix");
  });

  it("reports privacy-scoped manual install telemetry with an opt-out", () => {
    const script = readFileSync(join(root, "scripts/install-server.sh"), "utf8");
    const route = readFileSync(join(root, "www/src/app/api/install-telemetry/route.ts"), "utf8");

    expect(script).toContain("MATRIX_INSTALL_TELEMETRY_URL");
    expect(script).toContain("MATRIX_NO_TELEMETRY");
    expect(script).toContain("MATRIX_INSTALL_LOG");
    expect(script).toContain("MATRIX_INSTALL_COLOR");
    expect(script).toContain("Matrix OS server installer");
    expect(script).toContain("Browser shell + gateway + code-server + agents");
    expect(script).toContain("███╗   ███╗");
    expect(script).toContain("██████╗ ██╗██╗  ██╗");
    expect(script).toContain("[ \"${MATRIX_INSTALL_TELEMETRY:-1}\" != \"0\" ]");
    expect(script).toContain("matrix_manual_install_started");
    expect(script).toContain("matrix_manual_install_completed");
    expect(script).toContain("matrix_manual_install_failed");
    expect(script).toContain("--max-time 3");
    expect(script).toContain("installed_version");
    expect(script).toContain("domain_mode");
    expect(script).toContain("bundle_source");
    expect(script).not.toContain("\"handle\"");
    expect(script).not.toContain("MATRIX_INSTALL_HANDLE\",\"");

    expect(route).toContain("MAX_BODY_BYTES = 4096");
    expect(route).toContain("RATE_LIMIT_MAX_INSTALL_IDS");
    expect(route).toContain("installTelemetryBuckets");
    expect(route).toContain("allowInstallTelemetryEvent(input.installId)");
    expect(route).toContain("return jsonResponse(429)");
    expect(route).toContain("readBoundedJson");
    expect(route).toContain("request.body?.getReader()");
    expect(route).toContain("totalBytes > MAX_BODY_BYTES");
    expect(route).toContain("await reader.cancel()");
    expect(route).toContain("installTelemetrySchema");
    expect(route).toContain("const posthog = getPostHogClient()");
    expect(route).toContain("posthog.capture");
    expect(route).toContain("await shutdownPostHog()");
    expect(route).toContain("matrix_manual_install_completed");
    expect(route).toContain("install_surface: 'linux_vps_script'");
    expect(route).toContain("$ip: '0.0.0.0'");
  });

  it("protects the public surface with nginx basic auth and keeps services loopback", () => {
    const script = readFileSync(join(root, "scripts/install-server.sh"), "utf8");

    expect(script).toContain("auth_basic \"Matrix OS\"");
    expect(script).toContain("htpasswd_file=\"/etc/nginx/matrix-self-host.htpasswd\"");
    expect(script).toContain("legacy_htpasswd_file=\"/opt/matrix/env/nginx.htpasswd\"");
    expect(script).toContain('install -m 0640 -o root -g www-data "$legacy_htpasswd_file" "$htpasswd_file"');
    expect(script).toContain("auth_basic_user_file ${htpasswd_file}");
    expect(script).toContain("location = /health");
    expect(script).toContain("auth_basic off");
    expect(script).toContain("return 200 '{\"ok\":true}'");
    expect(script).toContain("openssl passwd -apr1");
    expect(script).toContain('if [ ! -f "$htpasswd_file" ]; then');
    expect(script).toContain("existing nginx Basic Auth credentials");
    expect(script).toContain('if [ -f /opt/matrix/env/initial-ui-password ]; then');
    expect(script).toContain("nginx Basic Auth challenge returned HTTP ${status}, expected 401");
    expect(script).toContain("gateway-auth-token.conf");
    expect(script).toContain("proxy_set_header Authorization \"Bearer %s\"");
    expect(script).toContain("proxy_set_header Authorization \"\"");
    expect(script).toContain("code-proxy-token.conf");
    expect(script).toContain("chmod 0600 /opt/matrix/env/code-proxy-token.conf");
    expect(script).toContain("include /opt/matrix/env/gateway-auth-token.conf");
    expect(script).toContain("location @matrix_code_root_ws");
    expect(script).toContain('if (\\$arg_reconnectionToken != "")');
    expect(script).toContain("error_page 418 = @matrix_code_root_ws");
    expect(script).toContain("proxy_set_header X-Forwarded-Prefix /code");
    expect(script).toContain("proxy_read_timeout 3600s");
    expect(script).toContain("proxy_pass http://127.0.0.1:8788");
    expect(script).toContain("proxy_pass http://127.0.0.1:3000");
    expect(script).toContain("proxy_pass http://127.0.0.1:4000");
    expect(script).not.toContain("proxy_pass http://127.0.0.1:8787");
    expect(script).toContain("proxy_set_header X-Matrix-Code-Proxy-Token \"%s\"");
    expect(script).toContain("-p 127.0.0.1:5432:5432");
    expect(script).toContain("location /cli/");
    expect(script).toContain("auth_basic off");
    expect(script).toContain("rewrite ^/cli/?(.*)\\$ /\\$1 break");
    expect(script).toContain("CLI gateway: ${ui_url%/}/cli");
    expect(script).toContain("MATRIX_TOKEN=\\$(sudo sed -n 's/^MATRIX_AUTH_TOKEN=//p' /opt/matrix/env/host.env)");
    expect(script).toContain("matrix shell ls --gateway ${ui_url%/}/cli --token \"\\$MATRIX_TOKEN\"");
    expect(script).not.toContain("MATRIX_TOKEN=\\$(sudo awk -F=");
    expect(script).not.toContain("-p 5432:5432");
    expect(script).not.toContain("grep '^MATRIX_CODE_PROXY_TOKEN='");
  });

  it("installs the core Matrix services without enabling managed-cloud backup requirements", () => {
    const script = readFileSync(join(root, "scripts/install-server.sh"), "utf8");

    expect(script).toContain("Installing OS packages");
    expect(script).toContain("Writing apt output to ${MATRIX_INSTALL_LOG}");
    expect(script).toContain("apt_get_update >>\"$MATRIX_INSTALL_LOG\" 2>&1");
    expect(script).toContain("timeout 300 apt-get install -y software-properties-common");
    expect(script).toContain("timeout 60 add-apt-repository -y universe");
    expect(script).toContain("apt-get install -y bubblewrap ca-certificates curl docker.io git nginx openssl postgresql-client procps socat sudo tar >>\"$MATRIX_INSTALL_LOG\" 2>&1");
    expect(script).toContain("configure_bwrap_apparmor");
    expect(script).toContain("dpkg --compare-versions \"$VERSION_ID\" ge 24.04");
    expect(script).toContain("cat >/etc/apparmor.d/bwrap <<'EOF'");
    expect(script).toContain("profile bwrap /usr/bin/bwrap flags=(unconfined)");
    expect(script).toContain('run_required "reloading AppArmor for bubblewrap" systemctl reload apparmor');
    expect(script.indexOf("add-apt-repository -y universe")).toBeLessThan(
      script.indexOf("apt-get install -y bubblewrap ca-certificates"),
    );
    expect(script).toContain("Downloading Matrix OS");
    expect(script).toContain("--progress-bar");
    expect(script).toContain("run_required");
    expect(script).toContain("restart_required_service matrix-gateway");
    expect(script).toContain("restart_optional_service matrix-developer-tools");
    expect(script).toContain("wait_http_ok");
    expect(script).toContain("Verifying Matrix OS");
    expect(script).toContain('${description} returned HTTP 500');
    expect(script).toContain("wait_http_ok_auth");
    expect(script).toContain('wait_http_ok "Matrix shell"');
    expect(script).toContain('wait_http_ok_auth "nginx shell"');
    expect(script).toContain('wait_http_ok_auth "nginx gateway API"');
    expect(script).toContain("journalctl -u matrix-shell -n 200 --no-pager");
    expect(script).toContain("tail -120 /var/log/nginx/error.log");
    expect(script).toContain("http://127.0.0.1:3000/");
    expect(script).toContain("http://127.0.0.1:4000/health");
    expect(script).toContain("http://127.0.0.1/api/identity");
    expect(script).toContain("optional developer tools installer");
    expect(script).toContain("Matrix OS core is still installed");
    expect(script).toContain("usermod -aG docker matrix");
    expect(script).toContain("testing nginx configuration");
    expect(script).toContain("install -m 0644 /opt/matrix/systemd/matrix-gateway.service");
    expect(script).toContain("install -m 0644 /opt/matrix/systemd/matrix-shell.service");
    expect(script).toContain("install -m 0644 /opt/matrix/systemd/matrix-code.service");
    expect(script).toContain("install -m 0644 /opt/matrix/systemd/matrix-code-server.service");
    expect(script).toContain("write_self_host_restore_service");
    expect(script).toContain("systemctl enable docker matrix-restore matrix-gateway matrix-shell matrix-code matrix-code-server");
    expect(script).toContain("systemctl enable --now docker");
    expect(script).not.toContain("systemctl restart docker");
    expect(script).not.toContain("write_postgres_compose");
    expect(script).not.toContain("postgres-compose.yml");
    expect(script).not.toContain("NOPASSWD:ALL");
    expect(script).not.toContain("systemctl enable matrix-db-backup");
    expect(script).not.toContain("systemctl enable matrix-sync-agent");
  });
});
