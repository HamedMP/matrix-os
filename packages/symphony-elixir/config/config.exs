import Config

config :phoenix, :json_library, Jason

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  url: [host: "localhost"],
  render_errors: [
    formats: [html: SymphonyElixirWeb.ErrorHTML, json: SymphonyElixirWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SymphonyElixir.PubSub,
  live_view: [signing_salt: "symphony-live-view"],
  secret_key_base: System.get_env("SYMPHONY_SECRET_KEY_BASE") || Base.encode64(:crypto.strong_rand_bytes(48)),
  check_origin: ["//localhost", "//127.0.0.1", "//[::1]"],
  server: false
