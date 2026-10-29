# Proposed public documentation update

Target: the existing Chat provider/connection documentation in the separate `FinnaAI/matrix-os-site` repository. This text is prepared locally and has not been published.

Electron Desktop keeps a session cache of available Chat providers and models so opening Chat or the provider selector stays responsive. When a supported connection workflow confirms sign-in, open Chat windows update the affected provider silently. Your draft and current provider selection stay in place. An unsuccessful or cancelled sign-in does not renew every provider.

Claude native connections and the device's ChatGPT plan connection remain independent. A ChatGPT plan connection must finish connecting the device to the selected Computer before its models become available. A sign-in receipt does not bypass the gateway's current model or account checks.

If an update cannot be checked, use the existing explicit Refresh/Check connection recovery. Switching accounts or Computers discards the previous session's provider authority.

Release note scope: this cache correction does not add a previously unavailable native Codex login method. Supported connection methods continue to depend on the surface and runtime capabilities.

Proposed Terminal follow-up, pending matching-client verification: when you choose **Connect Codex** from the Desktop Chat model picker, the supported native Terminal login uses the same confirmed connection flow as Settings. After browser authorization completes, return to the original Chat to select Codex models without reloading. Your unsent draft stays in place. A success line in an unrelated manually opened Terminal is not itself a confirmed Matrix connection.
