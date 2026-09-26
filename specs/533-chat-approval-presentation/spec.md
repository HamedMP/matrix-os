# Safe approval details and recorded decisions

## Problem and scope

Electron Desktop drops native approval activity descriptions, while Web and
Native Mobile retain them. All surfaces lose the recorded decision and present
decline, cancellation, approval, and terminal history without a decision as the
same resolved state. Electron Desktop renders a green success icon for each.

This change concerns presentation only. Existing authorize/decide requests,
receipts, permission policies, backend bridge behavior, and allowed decisions
remain unchanged. A separate owner investigates the actual Approve failure.

## Contract

1. The shared run-scoped approval projection is the source of details and
   recorded outcome on Web Canvas, Web Desktop, Electron Desktop, Web Mobile,
   and Native Mobile wherever approvals exist. Identity remains run ID plus
   approval ID; a historical identical ID cannot resolve another run.
2. Known Custom MCP descriptions use the existing exact envelope: Server UUID,
   Tool identifier, Arguments JSON object. The display projection accepts at
   most 4,000 input characters, strict UUID and ASCII tool identifier (1-128
   characters), and one plain top-level JSON object. It does not descend into
   values. Malformed/oversized Custom MCP envelopes show only a neutral privacy
   placeholder; no raw input fallback.
3. Display the server UUID and tool, plus at most 12 argument entries and at
   most 1,200 total output characters. Allowlisted names are url, query, path,
   limit, offset, page, cursor, id, name, content, payload, and timeout. Unknown
   names collapse to an unnamed other-arguments count. Display only null,
   string, number, boolean, array, or object type and `value withheld`; ALL
   argument values are withheld, including public URL paths and hostnames.
   This is a deliberately limited argument review surface. It does not enable
   reviewing the exact target URL or arbitrary payload before approval.
4. Existing unrelated legacy command/file/patch approval descriptions retain
   their current bounded review formatting. Their pre-existing producer safety
   boundary is not redesigned here. Known Custom MCP legacy envelopes take the
   same conservative path as native activities. Plain text is not treated as a
   Custom MCP envelope merely because it mentions a server.
5. Actual decisions show Approved (including approve_for_session), Declined,
   or Cancelled. Terminal history without a recorded decision shows `Approval
   ended without a recorded decision`, using neutral presentation. Only an
   actual approve decision gets success styling. Pending controls remain
   unchanged and submit the original run/approval IDs and decision.

## Security, resources, compatibility

No endpoints, persistence schema, database migrations, credentials, permissions,
or authentication matrix entries change. Owner/viewer authorization remains at
the existing detail and submission endpoints. A displayed summary is never an
authorization receipt. No raw arguments are newly passed to any renderer.
Input parsing is bounded before JSON parsing; output caps and top-level entry
caps prevent growth. No new long-lived Map or state store is needed. An absent
decision remains compatible with historical data and is never inferred from
terminal success, generic model text, or an optimistic button click.

## Implementation and validation plan

Extract a focused pure Custom MCP display helper in contracts; use it once from
canonicalChatApprovals. Replace resolved membership with a run-scoped recorded
decision map. Overlay the shared approval view into the existing Desktop
presentation instead of duplicating parsing in its 700+ LOC composition file.
Add the optional typed decision to the request presentation and share outcome
copy across Web/mobile/Desktop renderers. Keep adapter/protocol files untouched.

TDD covers native and legacy summaries, malformed/oversized input, arbitrary
argument names/nested private values, actual rendered Electron details/outcomes,
legacy review text preservation, each decision, terminal unknown neutrality,
and run-scoped collision. Run existing approval parity/presentation/transcript
suites, canonical types and repository pattern checks, then exact-head Greptile
and actual CI. Root captures actual Electron Desktop feature behavior; JSDOM
does not establish real-surface acceptance.

## Documentation deliverable

Update public-safe product documentation in this repository to explain bounded
details and truthful outcomes. A separate matrix-os-site PR is required if the
public site documents approvals; root coordinates that deliverable. Do not
claim live Custom MCP availability or a repaired authorization backend from
this presentation change. No live provider, paid inference, or mailbox call is
part of this validation.
