# Exact upstream helper characterization fixture.
# NousResearch/hermes-agent v0.22.0, e06df9c2eae6901f4c88f464e0ae6e753c0428b8.
# Source: hermes_cli/auth.py and hermes_cli/config.py (MIT).
# Only external storage operations are supplied by the isolated test harness.
from __future__ import annotations

# hermes_cli/auth.py function SHA256: c0ab1cc99585100930623538364baf896fd1f36e58ed65c2d3d292282fc2f031
def _update_config_for_provider(
    provider_id: str, inference_base_url: str, default_model: Optional[str] = None,
    *, clear_default: bool = False) -> Path:
    """Update config.yaml and auth.json to reflect the active provider.

    *default_model*, when given, is written as ``model.default`` in the same step so the gateway
    (which re-reads config per message) can't pick up the new provider before model selection
    finishes and send an OpenRouter-style ``vendor/model`` name to a direct API. *clear_default*
    removes ``model.default`` in that same write, for a caller that has no model to offer and must
    not leave the previous provider's model paired with the new host."""
    with _auth_store_lock():  # so auto-resolution picks this provider
        auth_store = _load_auth_store()
        auth_store["active_provider"] = provider_id
        _save_auth_store(auth_store)

    config_path = get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    require_readable_config_before_write(config_path)
    config = read_raw_config()
    current_model = config.get("model")
    if isinstance(current_model, dict):
        model_cfg = dict(current_model)
    else:
        model_cfg = {"default": current_model.strip()} if _nonempty_str(current_model) else {}
    model_cfg["provider"] = provider_id
    if inference_base_url and inference_base_url.strip():
        model_cfg["base_url"] = inference_base_url.rstrip("/")
    else:
        model_cfg.pop("base_url", None)  # clear stale base_url when switching providers

    # Built-in providers resolve credentials from env/auth state, not inline model.api_key left
    # over from a previous custom provider.
    from hermes_cli.config import clear_model_endpoint_credentials
    clear_model_endpoint_credentials(model_cfg)

    # An OpenRouter-formatted default like "anthropic/claude-opus-4.6" fails on direct-API
    # providers.
    if default_model:
        cur_default = model_cfg.get("default", "")
        if not cur_default or "/" in cur_default:
            model_cfg["default"] = default_model
    elif clear_default:
        model_cfg.pop("default", None)
    config["model"] = model_cfg
    atomic_config_replace(config_path, config)
    return config_path

# hermes_cli/config.py function SHA256: f631da84ec4e8a6e0352424d444d1c7c03950d377a13cfa020699936fc4e21ae
def clear_model_endpoint_credentials(
    model_cfg: dict[str, Any], *, clear_api_key: bool = True, clear_api_mode: bool = True,
    clear_base_url: bool = False) -> dict[str, Any]:
    """Remove stale inline endpoint credentials from a model config.
    ``model.api_key`` is valid only for explicit custom endpoints; built-in providers resolve
    credentials from env/auth.json/the pool. Leftovers keep secrets in config.yaml and can
    contaminate later custom resolution paths."""
    if not isinstance(model_cfg, dict):
        return model_cfg
    if clear_api_key:
        model_cfg.pop("api_key", None)
        model_cfg.pop("api", None)
        # key_env is a first-class credential POINTER (runtime_provider and
        # auxiliary_client resolve it), written by custom-endpoint activation.
        # Leaving it behind on a provider switch routes the NEW provider's
        # requests to the OLD endpoint's env var — same staleness class as an
        # inline api_key, so it clears under the same flag.
        model_cfg.pop("key_env", None)
        model_cfg.pop("api_key_env", None)
    if clear_api_mode:
        model_cfg.pop("api_mode", None)
    if clear_base_url:
        model_cfg.pop("base_url", None)
    return model_cfg
