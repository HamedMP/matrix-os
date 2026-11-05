# Remaining dependency work

## Follow-up snapshot — 29 October 2026

After merged PR #2968, the next root-workspace candidate reduces high findings from 12 to 4 (0 critical, 17 moderate, 12 low). It qualifies Metro 0.84.5, the Excalidraw converter with Nanoid 5.1.16, and Miniflare with Sharp 0.35.5 through their real consumers. The four remaining high advisory families are body-parser, node-forge, Electron and Zod. The omitted http-cache-semantics advisory stays open. No findings were dismissed or accepted.

The root scan does not cover the entire repository. Recovered mirror ingestion reports critical/high findings in the separate shell/mobile and default-app lockfiles. Those manifests require their own install/deployment-role review and intended package-manager updates; do not delete lockfiles merely to suppress alerts. The shipped offline mobile Mermaid artifact also embeds stale sanitizer/parser code and is being repaired separately, with native-device evidence still required.

## Previous PR history

Tracking: [GTM-305](https://linear.app/matrix-os/issue/GTM-305/remediate-the-vanta-github-dependency-vulnerability-backlog). These findings remain open, without dismissal or risk acceptance. The root-workspace scan after this remediation initially had 0 critical, 13 high, 16 moderate and 12 low findings. A subsequent registry scan after the Lodash review fix reports 0 critical, 12 high, 18 moderate and 12 low; this is a changing advisory-database snapshot, not additional code remediation. The cache advisory below remains open even though the later npm response omits it. Separate legacy lockfiles and other repositories are not covered by this scan.

| Remaining high family | Next step |
| --- | --- |
| body-parser | 2.4.0 enters the unchanged seven-day release policy on 29 October 2026 at 11:39:38 UTC. Resolve and retest then. |
| node-forge, http-cache-semantics | Current advisories list no patched version. Qualify a maintained patch or replace the affected Expo/ngrok dependency chains. |
| Electron | Remaining certificate mitigation requires 42.11.16 or newer. Qualify the major runtime upgrade with native packaging and desktop runtime tests. |
| sharp | Qualified in the follow-up candidate: actual Miniflare Worker image info/transform with Sharp 0.35.5. |
| image-size | Qualified in the follow-up candidate: maintained Metro 0.84.5 removes the affected parser. |
| Nanoid | Qualified in the follow-up candidate: the actual Excalidraw converter uses 5.1.16; IDs, frame membership and child bindings are retained. |
| Zod | Migrate remaining v3 consumers through compatible parent releases; direct v4 consumers are patched. |

Remaining moderate families are legacy request/tough-cookie, esbuild, Nanoid, uuid, stream-json, decode-uri-component and Electron. The later scan also flags `@hono/node-server` static-path double decoding ([GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)); its patched v2 parent migration requires separate compatibility qualification. Do not force incompatible major versions merely to change the scan count. Track each parent migration and validate its actual callers. No security-delay exemption was added.

The XML-parser patch changes mobile fingerprint inputs. App runtime 0.2.9 starts a new compatibility boundary and requires fresh native builds before release. The dependency PR does not publish a mobile build or OTA update.

References: [unpatched node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [unpatched cache advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).

Review correction: Lodash and Lodash-es 4.18.0 were withdrawn as bad releases. Both overrides and all root-lock consumers now use non-deprecated 4.18.1; reverting to the deprecated notice's 4.17.x advice would reintroduce the known security findings. A frozen install, affected rendering tests and desktop build validate this correction.
