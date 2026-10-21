# ENG-306 local qualification — 2026-10-17

Target: official Hermes v0.22.0, source
`e06df9c2eae6901f4c88f464e0ae6e753c0428b8`.
Dependency: ENG-298 / #2593 at
`ce625af53362c588d84c8da092c0ddaf1140170e`; its reconciler and owner-env
remain byte-identical. This layer contains only the Hermes upgrade.

## Cases and outcomes

| Case | Observable check | Outcome |
| --- | --- | --- |
| PM environment selection | Legacy, canonical committed generation, corrupt/oversized/FIFO records, escaped/symlink roots and legitimate interpreter symlinks | Passed in the 580-test local gate at 0ee11976a6 |
| Credential endpoint binding | Read-only replacement tuple API; reject effective custom routes and same-token route changes | Passed in that gate |
| Native writer admission | Broken selection after a cached probe proves no child started; repair permits retry | RED then GREEN; independently reviewed |
| Installer extras | PM records both `anthropic` and `mcp`; a failed PM command cannot report setup success | New RED: 3 failed / 5 passed; GREEN: 8/8 |
| Native streaming and builtin tool | Actual upstream process calls `read_file`; result enters the model history and final text streams through Matrix's adapter | Passed |
| Real MCP discovery/call/result | Actual upstream MCP 2.0.0 client exchanges initialize, tools/list and tools/call with a local stdio fixture; its result enters model history through the default tool_call bridge | Passed |
| Cold resume | A fresh upstream process resumes the same stored session; previous assistant, file result and MCP result are present in the next request | Passed |
| Cancel a held MCP call | Server observes tools/call with a held value, then notifications/cancelled after Matrix's native interrupt | Passed |
| Process cleanup | All three Hermes children close; all three recorded MCP PIDs disappear within bounded waits | Passed |
| Failed spawn cleanup | Injected missing executable must fail and clean up rather than await a nonexistent exit event forever | RED: hung until the 20s outer bound; GREEN: expected exit 1 without timeout |
| Types and patterns | Workspace typecheck; pattern scanner; shell syntax and diff checks | Passed; 5 scanner warning categories, 0 violations |
| Independent review | Recheck confinement, endpoint selection, immutable prefix ownership, fixture assertions and both cleanup paths | No remaining actionable P1/P2 after fixes |

The real-process fixture uses a fresh private HOME, explicit synthetic-only
environment, local file, stdio server and loopback fake model. Five loopback
inference requests; zero blocked external network attempts. No owner credentials,
OAuth, external MCP or paid model service. Startup/run deadlines and access guards
remain unchanged. The MCP test SDK lives in a task-owned venv: MCP 2.0.0,
httpx2 2.7.0 and Starlette 1.3.1; OpenAI 2.24.0 and Anthropic 0.87.0 come from the
existing qualified generation via an explicit test-only site path. This does
not prove production installation or deployment; PM records the required extras
in the production installer instead of adopting the fixture environment.

## Full gate and remaining acceptance

The new Node 24 full local suite was interrupted with SIGINT at the coordinator's
instruction during critical shared host disk/RAM pressure (exit 130). It is **not
green**. Before interruption, the unchanged fake-Codex 501-delta orchestrator case
failed; the same case passed in isolation (1 passed / 35 skipped). No assertion,
startup deadline or access guard was weakened. The incomplete run and isolated
receipt are retained; formal full CI must qualify the published exact head.

The previous no-install boundary and missing-MCP receipt are historical. This
resumed phase explicitly authorized a small task-owned SDK installation and
normal PR/CI/review work. No fresh live visual evidence exists for Web Canvas,
Web Desktop, Electron Desktop, Web Mobile or Native Mobile; these remain final
human/runtime acceptance items, with no approved N/A. Real account/provider
behavior, actual installer/update execution and deployment are not qualified.
No Slack or merge is authorized.

Public docs follow-up in `FinnaAI/matrix-os-site`: describe the managed v0.22.0
upgrade, owner-state preservation and retryable runtime setup failures. The
repository integration reference is updated in `docs/dev/hermes-matrix-skills.md`.
Recommend Hamed review the PM ownership/upgrade behavior before landing.

The external task receipt preserves exact heads, SDK inventory, native event
log, RED/GREEN logs, independent review and the interrupted full-gate snapshot.
During disk relief, a duplicate upstream source checkout was removed before its
Git alternate-object dependency was noticed. The object store was restored from
the exact official tag; active source HEAD and clean diff were reverified. No
runtime config or test-result log was replaced.
