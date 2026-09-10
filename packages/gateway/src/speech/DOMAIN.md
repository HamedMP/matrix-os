# Gateway speech boundary

This directory is the authenticated runtime facade for the platform speech
service. It never selects a provider and never reads a speech-provider key.

## Source of truth and auth

- Platform capability policy and durable operation state are authoritative.
- The browser uses the gateway's existing authenticated session. The route
  resolves that principal through `requireRequestPrincipal` and only forwards
  when its owner matches the runtime-bound platform client identity.
- Gateway-to-platform calls reuse the provisioned, runtime-bound funded-AI
  credential. A user handle, Gemini compatibility token, browser field, or
  legacy shared gateway bearer is not a platform speech credential.
- The upstream path, handle and runtime slot come only from validated runtime
  configuration. The browser cannot supply a provider, model, source kind,
  owner, machine or runtime identity.

## Bounded lifecycle

- Browser capture produces bounded mono PCM16 and packages it as WAV. The
  platform independently validates the WAV structure and decoded sample count;
  client timers and MIME labels are not trusted duration evidence.
- The gateway applies Hono body limits before multipart parsing and sends one
  bounded in-memory recording upstream. Responses are capped before JSON
  decoding. Platform calls have timeouts, reject redirects and are not retried.
- Local recording bytes live only for the active draft attempt. Operational
  records contain neither source audio nor transcript text.
- Navigation or runtime changes fence the local generation, stop capture,
  abort the upload and best-effort request a platform tombstone. A late result
  cannot mutate another chat draft.

## Release gate

`MATRIX_PLATFORM_SPEECH_ENABLED` is off by default. When it is explicitly
enabled, startup requires the platform URL, machine handle, owner ID, machine
ID, runtime slot and runtime credential. Capability still remains unavailable
unless the platform policy, funding source, provider configuration and media
validation gates are all ready. Real provider/account, browser and packaged
Electron evidence is intentionally deferred; do not enable a release from unit
fixtures alone.
