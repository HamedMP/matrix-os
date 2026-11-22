# Config templates for bootstrap.sh (spec 2701, ENG-535). Sourced, not run.
#
# Each render_* function writes one file to stdout. They read secrets only
# through secret() and the validated inputs set by resolve_inputs().

server_regex() {
  printf '%s' "${SERVER_NAME//./\\.}"
}

render_homeserver() {
  cat <<EOF
# Rendered by bootstrap.sh. Edit lib/templates.sh, not this file.
server_name: "$SERVER_NAME"
public_baseurl: "https://$PUBLIC_HOSTNAME/"
pid_file: /data/homeserver.pid
log_config: /data/log.config
signing_key_path: /data/signing.key
media_store_path: /data/media_store
report_stats: false
enable_metrics: false

listeners:
  - port: 8008
    type: http
    tls: false
    x_forwarded: true
    bind_addresses: ["0.0.0.0"]
    resources:
      - names: [client]
        compress: false

database:
  name: psycopg2
  args:
    user: synapse
    password: "$(secret db-synapse-password)"
    dbname: synapse
    host: postgres
    port: 5432
    cp_min: 5
    cp_max: 10

registration_shared_secret: "$(secret synapse-registration-shared-secret)"
macaroon_secret_key: "$(secret synapse-macaroon-secret-key)"
form_secret: "$(secret synapse-form-secret)"

# Closed homeserver: no federation, no registration, no public directory.
federation_domain_whitelist: []
trusted_key_servers: []
suppress_key_server_warning: true
serve_server_wellknown: false
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false
room_list_publication_rules:
  - action: deny
enable_room_list_search: false
enable_registration: false
allow_guest_access: false
enable_3pid_changes: false
auto_join_rooms: []
user_directory:
  enabled: false
require_auth_for_profile_requests: true
limit_profile_requests_to_users_who_share_rooms: true
presence:
  enabled: false
push:
  enabled: false
url_preview_enabled: false
encryption_enabled_by_default_for_room_type: "off"
forget_rooms_on_leave: true

# The homeserver is a relay buffer; canonical history lives in owner Postgres.
retention:
  enabled: true
  default_policy:
    min_lifetime: 1d
    max_lifetime: 7d
  allowed_lifetime_min: 1d
  allowed_lifetime_max: 7d
  purge_jobs:
    - interval: 12h
redaction_retention_period: 1d
forgotten_room_retention_period: 1d
user_ips_max_age: 7d

max_upload_size: 50M
max_image_pixels: 32M
dynamic_thumbnails: false
media_retention:
  local_media_lifetime: 7d
  remote_media_lifetime: 1d

# Bridge appservice users and double-puppeted owners are exempt through
# rate_limited: false in their registrations. These limits apply to owner
# client tokens (spec: 30 sends per owner per minute).
rc_message:
  per_second: 1
  burst_count: 30
rc_login:
  address:
    per_second: 0.17
    burst_count: 10
  account:
    per_second: 0.17
    burst_count: 10
  failed_attempts:
    per_second: 0.17
    burst_count: 3
rc_joins:
  local:
    per_second: 0.5
    burst_count: 20
  remote:
    per_second: 0.01
    burst_count: 1
rc_invites:
  per_room:
    per_second: 1
    burst_count: 20
  per_user:
    per_second: 0.5
    burst_count: 20
  per_issuer:
    per_second: 1
    burst_count: 20

app_service_config_files:
  - /data/appservices/whatsapp.yaml
  - /data/appservices/telegram.yaml
  - /data/appservices/linkedin.yaml
  - /data/appservices/doublepuppet.yaml
EOF
}

render_synapse_log_config() {
  cat <<'EOF'
version: 1
formatters:
  precise:
    format: "%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse.storage.SQL:
    level: WARNING
  twisted:
    level: WARNING
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
EOF
}

render_signing_key() {
  printf '%s\n' "$(secret synapse-signing-key)"
}

render_registration() {
  local network="$1"
  cat <<EOF
id: $network
url: "http://mautrix-$network:$(bridge_port "$network")"
as_token: "$(secret "$network-as-token")"
hs_token: "$(secret "$network-hs-token")"
sender_localpart: "$(secret "$network-sender-localpart")"
rate_limited: false
namespaces:
  users:
    - regex: '^@${network}bot:$(server_regex)\$'
      exclusive: true
    - regex: '^@${network}_.*:$(server_regex)\$'
      exclusive: true
de.sorunome.msc2409.push_ephemeral: true
receive_ephemeral: true
EOF
}

render_doublepuppet_registration() {
  cat <<EOF
# Double puppeting: lets the bridges act as an owner's own Matrix user so
# messages sent from the owner's phone appear as the owner. Scoped to owner
# localparts; never matches the admin, bridge bots or ghosts.
id: doublepuppet
url: null
as_token: "$(secret doublepuppet-as-token)"
hs_token: "$(secret doublepuppet-hs-token)"
sender_localpart: "$(secret doublepuppet-sender-localpart)"
rate_limited: false
namespaces:
  users:
    - regex: '^@${OWNER_LOCALPART_REGEX}:$(server_regex)\$'
      exclusive: false
EOF
}

render_network_whatsapp() {
  cat <<'EOF'
network:
  os_name: Matrix OS
  browser_name: unknown
  proxy: null
  get_proxy_url: null
  proxy_only_login: false
  displayname_template: '{{or .FullName .BusinessName .PushName .Phone "Unknown user"}}'
  call_start_notices: true
  identity_change_notices: false
  send_presence_on_typing: false
  enable_status_broadcast: false
  disable_status_broadcast_send: true
  mute_status_broadcast: true
  pinned_tag: m.favourite
  archive_tag: null
  status_broadcast_tag: m.lowpriority
  whatsapp_thumbnail: false
  url_previews: false
  extev_polls: false
  disable_view_once: false
  force_active_delivery_receipts: false
  direct_media_auto_request: false
  initial_auto_reconnect: true
  use_whatsapp_retry_store: false
  max_member_sync: 256
  lazy_avatars: false
  animated_sticker:
    target: webp
    args:
      width: 320
      height: 320
      fps: 25
  history_sync:
    max_initial_conversations: 20
    request_full_sync: false
    dispatch_wait: 1m
    full_sync_config:
      days_limit: null
      size_mb_limit: null
      storage_quota_mb: null
    media_requests:
      auto_request_media: false
      request_method: immediate
      request_local_time: 120
      max_async_handle: 2
    backwards_on_demand: false
EOF
}

render_network_telegram() {
  cat <<EOF
network:
  api_id: $TELEGRAM_API_ID
  api_hash: "$(secret telegram-api-hash)"
  device_info:
    device_model: Matrix OS
    system_version: ""
    app_version: auto
    lang_code: en
    system_lang_code: en
  animated_sticker:
    target: gif
    convert_from_webm: false
    args:
      width: 256
      height: 256
      fps: 25
  member_list:
    max_initial_sync: 100
    sync_broadcast_channels: false
    skip_deleted: true
  ping:
    interval_seconds: 30
    timeout_seconds: 10
  proxy:
    type: disabled
    address: ""
    username: ""
    password: ""
  sync:
    update_limit: 100
    create_limit: 20
    login_sync_limit: 20
    direct_chats: true
  takeout:
    dialog_sync: false
    forward_backfill: false
    backward_backfill: false
  max_member_count: 2000
  contact_avatars: false
  contact_names: false
  always_custom_emoji_reaction: false
  always_tombstone_on_supergroup_migration: false
  image_as_file_pixels: 16777216
  disable_view_once: false
  video_url_preview_as_file: false
  bridge_communities: false
EOF
}

render_network_linkedin() {
  cat <<'EOF'
network:
  displayname_template: "{{ with .Organization }}{{ . }}{{ else }}{{ .FirstName }} {{ .LastName }}{{ end }}"
  sync:
    update_limit: 0
    create_limit: 20
EOF
}

render_bridge_config() {
  local network="$1" port label
  port="$(bridge_port "$network")"
  label="$(bridge_label "$network")"
  printf '# Rendered by bootstrap.sh. Edit lib/templates.sh, not this file.\n'
  "render_network_$network"
  cat <<EOF

bridge:
  command_prefix: "!$network"
  personal_filtering_spaces: false
  private_chat_portal_meta: true
  async_events: false
  # Every owner gets their own portal rooms, even for shared groups.
  # Irreversible once portals exist: never turn this off.
  split_portals: true
  resend_bridge_info: false
  no_bridge_info_state_key: false
  bridge_status_notices: errors
  transient_state_debounce: 0s
  send_reconnect_wait: 10s
  unknown_error_auto_reconnect: null
  unknown_error_max_auto_reconnects: 10
  bridge_matrix_leave: false
  bridge_notices: false
  tag_only_on_create: true
  only_bridge_tags: [m.favourite, m.lowpriority]
  mute_only_on_create: true
  deduplicate_matrix_messages: true
  portal_event_buffer: 64
  cross_room_replies: false
  revert_failed_state_changes: false
  kick_matrix_users: true
  enable_send_state_requests: false
  phone_numbers_in_profile: false
  view_limited_media: false
  cleanup_on_logout:
    enabled: true
    manual:
      private: delete
      relayed: delete
      shared_no_users: delete
      shared_has_users: kick
    bad_credentials:
      private: nothing
      relayed: nothing
      shared_no_users: nothing
      shared_has_users: nothing
  relay:
    enabled: false
    admin_only: true
    prefer_default: false
    allow_bridge: false
    default_relays: []
  portal_create_filter:
    mode: deny
    list: []
    always_deny_from_login: []
  # Owners on this homeserver may log in one account each; nobody is admin.
  permissions:
    "*": block
    "$SERVER_NAME":
      send_events: true
      commands: false
      login: true
      double_puppet: true
      admin: false
      manage_relay: false
      max_logins: 1

database:
  type: postgres
  uri: "postgres://$network:$(secret "db-$network-password")@postgres:5432/$network?sslmode=disable"
  max_open_conns: 10
  max_idle_conns: 2
  max_conn_idle_time: null
  max_conn_lifetime: null

homeserver:
  address: http://synapse:8008
  domain: "$SERVER_NAME"
  software: standard
  status_endpoint: null
  message_send_checkpoint_endpoint: null
  async_media: false
  websocket: false
  ping_interval_seconds: 0
  retry_limit: 4

appservice:
  address: "http://mautrix-$network:$port"
  public_address: ""
  hostname: 0.0.0.0
  port: $port
  id: $network
  bot:
    username: ${network}bot
    displayname: "$label bridge bot"
    avatar: ""
  ephemeral_events: true
  async_transactions: false
  as_token: "$(secret "$network-as-token")"
  hs_token: "$(secret "$network-hs-token")"
  username_template: "${network}_{{.}}"

matrix:
  message_status_events: false
  delivery_receipts: false
  message_error_notices: true
  sync_direct_chat_list: true
  federate_rooms: false
  upload_file_threshold: 5242880
  ghost_extra_profile_info: false

analytics:
  token: null
  url: https://api.segment.io/v1/track
  user_id: null

# Reached only through the proxy's gated /bridges/$network/ prefix.
provisioning:
  shared_secret: "$(secret "$network-provisioning-secret")"
  allow_matrix_auth: false
  debug_endpoints: false
  enable_session_transfers: false
  fail_on_webauthn: true
  request_id_header: Request-Id
  trust_incoming_request_id: false

public_media:
  enabled: false
  signing_key: "$(secret "$network-public-media-key")"
  expiry: 0
  hash_length: 32
  path_prefix: /_mautrix/publicmedia
  use_database: false

direct_media:
  enabled: false

backfill:
  enabled: true
  max_initial_messages: 50
  max_catchup_messages: 200
  unread_hours_threshold: 720
  threads:
    max_initial_messages: 20
  queue:
    enabled: false
    manual: false
    batch_size: 100
    batch_delay: 20
    max_batches: 0
    max_batches_override: {}

double_puppet:
  servers: {}
  allow_discovery: false
  secrets:
    "$SERVER_NAME": "as_token:$(secret doublepuppet-as-token)"

# Phase 0: no end-to-bridge encryption.
encryption:
  allow: false
  default: false
  require: false
  appservice: false
  msc4190: false
  msc4392: false
  self_sign: false
  allow_key_sharing: false
  plaintext_mentions: false
  pickle_key: "$(secret "$network-pickle-key")"

env_config_prefix: null

logging:
  min_level: info
  writers:
    - type: stdout
      format: json
EOF
}

render_caddyfile() {
  local gate network
  gate="$(secret gate-secret)"
  cat <<EOF
{
	email $ACME_EMAIL
	admin off
	servers {
		protocols h1 h2
	}
}

$PUBLIC_HOSTNAME {
	request_body {
		max_size 64MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}

	@federation path /_matrix/federation/* /_matrix/key/* /.well-known/matrix/*
	handle @federation {
		respond 404
	}

	# Platform only: the admin API, and client login for minting owner
	# device tokens with the double-puppet appservice token.
	@platform_admin {
		path /_synapse/admin/* /_matrix/client/v3/login
		header X-Matrix-Bridge-Gate $gate
	}
	handle @platform_admin {
		request_header -X-Matrix-Bridge-Gate
		reverse_proxy synapse:8008
	}
EOF
  for network in $NETWORKS; do
    cat <<EOF

	@platform_$network {
		path /bridges/$network/_matrix/provision/*
		header X-Matrix-Bridge-Gate $gate
	}
	handle @platform_$network {
		request_header -X-Matrix-Bridge-Gate
		uri strip_prefix /bridges/$network
		reverse_proxy mautrix-$network:$(bridge_port "$network")
	}
EOF
  done
  cat <<'EOF'

	# Owner gateways use tokens minted by the platform, so login and
	# registration are never reachable without the gate.
	@client {
		path /_matrix/client/* /_matrix/media/*
		not path_regexp ^/_matrix/client/[^/]+/(login|register)(/.*)?$
	}
	handle @client {
		request_header -X-Matrix-Bridge-Gate
		reverse_proxy synapse:8008
	}

	handle {
		respond 404
	}
}
EOF
}

render_host_env() {
  cat <<EOF
# Non-secret host settings saved by bootstrap.sh.
MBH_PUBLIC_HOSTNAME=$PUBLIC_HOSTNAME
MBH_SERVER_NAME=$SERVER_NAME
MBH_ACME_EMAIL=$ACME_EMAIL
EOF
}

render_compose_env() {
  printf 'MBH_STATE_DIR=%s\n' "$STATE_DIR"
}

render_postgres_password() {
  printf '%s\n' "$(secret postgres-superuser-password)"
}

render_platform_env() {
  cat <<EOF
# Matrix OS platform settings for the shared messaging bridge host.
# Generated by bootstrap.sh. Store in the platform secret manager; never commit.
MESSAGING_BRIDGE_HOST_URL=https://$PUBLIC_HOSTNAME
MESSAGING_BRIDGE_SERVER_NAME=$SERVER_NAME
MESSAGING_BRIDGE_ADMIN_TOKEN=$(secret admin-access-token)
MESSAGING_BRIDGE_GATE_SECRET=$(secret gate-secret)
MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN=$(secret doublepuppet-as-token)
MESSAGING_BRIDGE_USER_ID_KEY=$(secret platform-user-id-key)
MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP=$(secret whatsapp-provisioning-secret)
MESSAGING_BRIDGE_PROVISIONING_SECRET_TELEGRAM=$(secret telegram-provisioning-secret)
MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN=$(secret linkedin-provisioning-secret)
EOF
}
