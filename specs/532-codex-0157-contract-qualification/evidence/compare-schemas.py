"""Reproduce the complete 0.156.1 -> 0.157.0 generated-schema shape diff."""

import argparse
import gzip
import json
from pathlib import Path


root = Path(__file__).resolve().parents[3]
fixtures = root / "tests/fixtures/codex-0157"
parser = argparse.ArgumentParser()
parser.add_argument(
    "--new-schema",
    type=Path,
    default=fixtures / "app-server-schema-0157.json.gz",
    help="Override the new compressed schema for a mutation check.",
)
args = parser.parse_args()


def load(path):
    with gzip.open(path, "rt") as source:
        return json.load(source)


old = load(fixtures / "app-server-schema-0156.json.gz")
new = load(args.new_schema)
assert set(old) == set(new), "top-level schema keys changed"
assert {k: v for k, v in old.items() if k != "definitions"} == {
    k: v for k, v in new.items() if k != "definitions"
}, "top-level schema metadata changed"
before = old["definitions"]
after = new["definitions"]
assert set(before) == set(after), "top-level definitions were added or removed"
changed_definitions = sorted(k for k in before if before[k] != after[k])
assert changed_definitions == [
    "ClientRequest", "InitializeCapabilities", "ServerNotification", "v2"
], f"unexpected top-level definition changes: {changed_definitions}"
print("Changed top-level definitions:", changed_definitions)


def variants(name, expected_added):
    def index(definition):
        indexed = {
            value["properties"]["method"]["enum"][0]: value
            for value in definition["oneOf"]
        }
        assert len(indexed) == len(definition["oneOf"]), f"duplicate {name} methods"
        return indexed

    previous, current = index(before[name]), index(after[name])
    added = sorted(current.keys() - previous.keys())
    removed = sorted(previous.keys() - current.keys())
    modified = sorted(k for k in previous.keys() & current.keys() if previous[k] != current[k])
    print(f"{name}: {len(previous)} -> {len(current)}")
    print("  added:", added)
    print("  removed:", removed)
    print("  modified existing variants:", modified)
    assert added == expected_added, f"unexpected {name} additions: {added}"
    assert not removed, f"removed {name} variants: {removed}"
    assert not modified, f"modified {name} variants: {modified}"


variants("ClientRequest", [
    "account/gatewayOAuth/cancel",
    "account/gatewayOAuth/login",
    "account/gatewayOAuth/read",
])
variants("ServerNotification", ["account/gatewayOAuth/changed"])

old_capabilities = before["InitializeCapabilities"]
new_capabilities = after["InitializeCapabilities"]
assert old_capabilities.get("required") == new_capabilities.get("required")
assert all(new_capabilities["properties"][key] == value
           for key, value in old_capabilities["properties"].items())
assert {k: v for k, v in old_capabilities.items() if k != "properties"} == {
    k: v for k, v in new_capabilities.items() if k != "properties"
}, "InitializeCapabilities metadata changed"
capability_additions = sorted(
    new_capabilities["properties"].keys() - old_capabilities["properties"].keys()
)
assert capability_additions == ["explicitGatewayOauth"], (
    f"unexpected InitializeCapabilities additions: {capability_additions}"
)
print("InitializeCapabilities added optional properties:", capability_additions)

old_v2, new_v2 = before["v2"], after["v2"]
added_types = sorted(new_v2.keys() - old_v2.keys())
removed_types = sorted(old_v2.keys() - new_v2.keys())
modified_types = sorted(k for k in old_v2.keys() & new_v2.keys() if old_v2[k] != new_v2[k])
print("v2 added types:", added_types)
print("v2 removed types:", removed_types)
print("v2 modified existing types:", modified_types)
assert added_types == [
    "GatewayOAuthCancelResponse", "GatewayOAuthChangedNotification",
    "GatewayOAuthLoginResponse", "GatewayOAuthReadResponse", "GatewayOAuthStatus",
    "McpResourceReadTarget", "PluginEntrypoint", "PluginExtensions", "PluginIcon",
    "PluginQuickAction", "PluginQuickActionTarget", "PluginSearchProvider",
    "PluginSearchProviderCall", "PluginSettings",
], f"unexpected v2 type additions: {added_types}"
assert not removed_types, f"removed v2 types: {removed_types}"
expected_optional_additions = {
    "McpResourceReadParams": ["target"],
    "McpServerStatus": ["httpOrigin"],
    "PluginSummary": ["extensions"],
    "ThreadItemEntry": ["completedAtMs", "startedAtMs"],
    "ThreadRealtimeStartParams": ["backendReasoningStatus"],
}
assert modified_types == sorted(expected_optional_additions), (
    f"unexpected modified v2 types: {modified_types}"
)
for name in modified_types:
    previous, current = old_v2[name], new_v2[name]
    previous_properties, current_properties = previous["properties"], current["properties"]
    assert set(previous_properties) <= set(current_properties), f"removed {name} property"
    assert all(current_properties[key] == value for key, value in previous_properties.items()), (
        f"changed existing {name} property"
    )
    assert {k: v for k, v in previous.items() if k != "properties"} == {
        k: v for k, v in current.items() if k != "properties"
    }, f"changed existing {name} metadata or required fields"
    added = sorted(current_properties.keys() - previous_properties.keys())
    assert added == expected_optional_additions[name], f"unexpected {name} additions: {added}"
    print(f"  {name} added optional properties: {added}")
    for field in added:
        print(f"    {field}: {json.dumps(current_properties[field], sort_keys=True)}")
