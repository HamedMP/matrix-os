# Supervised Claude tool approval

[ENG-267](https://linear.app/matrix-os/issue/ENG-267/fixchat-offer-tool-approval-instead-of-a-dead-end-denial-in-supervised)

## Outcome

A Supervised Claude built-in tool request waits for the owner instead of ending on "Tool approval is unavailable in this Chat connection." The run emits the existing `approval.requested` event. Needs you stays the one attention lane. The card matches the Desktop tool-approval frame: Allow once, Allow in this chat, Not now, and Always allow, which opens the permission menu for the next request. The in-flight turn stays Supervised.

Allow once continues that call. Allow in this chat continues it and remembers that exact tool for the rest of this run, until Undo. Not now lets the model continue without the tool. An unanswered request expires after 10 minutes, drops the allow buttons, and can be tried again as a new request.

## Authority

The stdio `can_use_tool` callback never writes allow by itself. Platform still mints `x-matrix-custom-mcp-approval-proof` on the existing owner approval POST. That payload now also accepts `approve_for_session`. Custom MCP and integration controllers still refuse to apply a session decision. Built-in tools use it only after the same proof check. A missing or rejected proof leaves the tool unanswered. This does not add rows to the Custom MCP challenge tables.

No new endpoint. The approval POST keeps its current owner authentication, body limit, and generic error mapping.

## Bounds

At most 16 pending built-in approvals per run. Tool input over 4,000 characters is denied without a prompt. Unanswered requests expire after 10 minutes, resolve as cancelled with reason `expired`, and deny the tool. Shutdown denies any remainder without calling it expired. A verified Allow in this chat is remembered in gateway memory for that run and exact tool name, not the card title, which several tools share. It is capped at 64 grants, oldest dropped first, and ends with the run, so the next message asks again and no grant outlives its Undo. Undo is offered only while that run is still active. It sends a proven decline, removes the grant, and records `reason: "session_revoked"` on the same resolution so the card drops Undo. Matrix `mcp__` tools and `AskUserQuestion` keep their current controls.

## Deferred

Full access applies to the next request because `permissionMode` is already frozen for the in-flight turn. Other harnesses and `agent_full_access_required` stay follow-ups.

Web Canvas, Web Desktop, and Electron Desktop render this card from the same approval view. They do not grow a second attention lane. Web Mobile and Native Mobile are out of scope for this change; Native Mobile keeps its existing approval message until a follow-up brings it the same card.

Suggest the Chat owner review the prompt copy before rollout.

## Documentation

A separate PR in `FinnaAI/matrix-os-site` under `content/docs/` explains Supervised tool approval for owners: what Allow once, Allow in this chat (this run only), Not now, and Undo each do, the 10-minute expiry, and how Always allow switches the next request to Full access.
