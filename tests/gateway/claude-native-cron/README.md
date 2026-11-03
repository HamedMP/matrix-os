# Native control qualification

`qualify-control.py` exercises the real Linux Claude Code 2.1.317 executable
with a synthetic loopback Anthropic response and two synthetic MCP children.
It uses no account, provider credentials, paid inference or external network.
This qualifies a control protocol, not the final Matrix Chat/backend flow.

Obtain the executable from Anthropic's official versioned platform package and
verify its registry integrity before use. The probe also requires these exact
SHA-256 hashes and the matching `--version` result:

| Linux architecture | Executable SHA-256 |
| --- | --- |
| arm64 (`aarch64`) | `563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa` |
| x64 (`x86_64`) | `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0` |

Run in a disposable, non-root Linux container with only loopback networking,
zero capabilities, no-new-privileges, a read-only filesystem, bounded resources
and an init process to reap orphaned MCP children. Mount only the executable,
this fixture directory and an empty writable report directory. Do not mount a
home directory, Docker socket, Matrix data or account configuration.

```sh
docker run --init --rm --network none --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 \
  --memory 1536m --pids-limit 128 --cpus 2 --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  -v /absolute/path/to/claude:/fixture/claude:ro \
  -v /absolute/path/to/claude-native-cron:/fixture/tests:ro \
  -v /absolute/path/to/writable-reports:/output \
  node:24-bookworm python3 /fixture/tests/qualify-control.py \
  --native-executable /fixture/claude --scenario direct-mcp \
  --report /output/direct-mcp.json
```

Repeat with `--scenario reinitialize-negative` and a new report filename.
The script refuses an existing report and bounds its scenario to 40 seconds,
plus shutdown. Exit zero requires `qualified: true`, native exit zero, both
MCP children absent and temporary data removed.

- `direct-mcp`: initialize once, hold UserPromptSubmit, replace the same named
  MCP server, observe its old child gone and new child alive, then release the
  original callback. Exactly one API request must follow replacement ACK and
  release; exactly one user frame and one native result are permitted.
- `reinitialize-negative`: repeat native initialize while the prompt is held.
  Although the ACK succeeds, native cancels that prompt. Expect the exact
  blocked result, no API request and no replay. This guards against treating
  successful initialization as proof that the original prompt survived.

Both scenarios passed on Linux arm64 on 2026-11-03. The same direct replacement
and negative behavior were independently observed on actual Linux x64
2.1.317 during the live diagnostic investigation. Synthetic responses do not
prove native Cron timing, real Matrix MCP authorization or Chat persistence;
those require separate exact-head live acceptance.
