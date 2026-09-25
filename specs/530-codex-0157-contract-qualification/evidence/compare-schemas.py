"""Reproduce the complete 0.156.1 -> 0.157.0 generated-schema shape diff."""

import gzip
import json
from pathlib import Path


root = Path(__file__).resolve().parents[3]
fixtures = root / "tests/fixtures/codex-0157"


def load(version):
    with gzip.open(fixtures / f"app-server-schema-{version}.json.gz", "rt") as source:
        return json.load(source)


old = load("0156")
new = load("0157")
assert set(old) == set(new), "top-level schema keys changed"
before = old["definitions"]
after = new["definitions"]
assert set(before) == set(after), "top-level definitions were added or removed"
print("Changed top-level definitions:", sorted(k for k in before if before[k] != after[k]))


def variants(name):
    def index(definition):
        return {
            value["properties"]["method"]["enum"][0]: value
            for value in definition["oneOf"]
        }

    previous, current = index(before[name]), index(after[name])
    added = sorted(current.keys() - previous.keys())
    removed = sorted(previous.keys() - current.keys())
    modified = sorted(k for k in previous.keys() & current.keys() if previous[k] != current[k])
    print(f"{name}: {len(previous)} -> {len(current)}")
    print("  added:", added)
    print("  removed:", removed)
    print("  modified existing variants:", modified)
    return added, removed, modified


variants("ClientRequest")
variants("ServerNotification")

old_capabilities = before["InitializeCapabilities"]
new_capabilities = after["InitializeCapabilities"]
assert old_capabilities.get("required") == new_capabilities.get("required")
assert all(new_capabilities["properties"][key] == value
           for key, value in old_capabilities["properties"].items())
print("InitializeCapabilities added optional properties:",
      sorted(new_capabilities["properties"].keys() - old_capabilities["properties"].keys()))

old_v2, new_v2 = before["v2"], after["v2"]
added_types = sorted(new_v2.keys() - old_v2.keys())
removed_types = sorted(old_v2.keys() - new_v2.keys())
modified_types = sorted(k for k in old_v2.keys() & new_v2.keys() if old_v2[k] != new_v2[k])
print("v2 added types:", added_types)
print("v2 removed types:", removed_types)
print("v2 modified existing types:", modified_types)
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
    print(f"  {name} added optional properties: {added}")
    for field in added:
        print(f"    {field}: {json.dumps(current_properties[field], sort_keys=True)}")
