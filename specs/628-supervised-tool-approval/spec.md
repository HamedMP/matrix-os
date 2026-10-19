# Supervised Claude tool approval

[ENG-267](https://linear.app/matrix-os/issue/ENG-267/fixchat-offer-tool-approval-instead-of-a-dead-end-denial-in-supervised)

## Outcome

In Supervised and Auto Accept Edits, a Claude built-in tool request that Claude asks about waits for the owner instead of ending on "Tool approval is unavailable in this Chat connection." Auto Accept Edits already applies file edits on its own, so the card appears there for other tools such as web search. The run emits the existing `approval.requested` event. Needs you stays the one attention lane. The card offers Allow once, Not now, and Always allow, which opens the permission menu.

Allow once continues that call; the next call asks again. Not now lets the model continue without the tool. In the Always allow menu, Full access switches the following messages to Full access and approves this request once, so the run continues; Supervised just closes the menu. The in-flight turn keeps its mode. An unanswered request expires after 10 minutes, drops the allow buttons, and can be tried again as a new request.

## Authority

The stdio `can_use_tool` callback never writes allow by itself. Every decision is a one-time `approve`, `decline`, or `cancel` that the existing Platform proof (`x-matrix-custom-mcp-approval-proof`) already signs, so this change needs no Platform deploy. Built-in tools apply a decision only after the same proof check. A missing or rejected proof leaves the tool unanswered. This does not add rows to the Custom MCP challenge tables.

No new endpoint. The approval POST keeps its current owner authentication, body limit, and generic error mapping.

## Bounds

At most 16 pending built-in approvals per run. Tool input over 4,000 characters is denied without a prompt. Unanswered requests expire after 10 minutes, resolve as cancelled with reason `expired`, and deny the tool. Shutdown denies any remainder without calling it expired. Nothing is remembered between requests. Matrix `mcp__` tools and `AskUserQuestion` keep their current controls.

## Deferred

A grant that covers later calls ("Allow for this run") is a follow-up. It needs the Platform to sign `approve_for_session` first, so it ships Platform-first, then the gateway and card.

Auto keeps its immediate denial: its classifier refusals are deliberate, and a card there would let one click override them. Other harnesses and `agent_full_access_required` stay follow-ups.

Web Canvas, Web Desktop, and Electron Desktop render this card from the same approval view. They do not grow a second attention lane. Web Mobile and Native Mobile are out of scope for this change; Native Mobile keeps its existing approval message until a follow-up brings it the same card.

Suggest the Chat owner review the prompt copy before rollout.

## Documentation

A separate PR in `FinnaAI/matrix-os-site` under `content/docs/` explains tool approval for owners: what Allow once and Not now do, the 10-minute expiry, and how Always allow switches to Full access and approves the waiting request.
