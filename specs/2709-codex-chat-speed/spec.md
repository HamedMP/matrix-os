# Codex Chat speed

Tracking issue: [ENG-553](https://linear.app/matrix-os/issue/ENG-553/fix-codex-chat-silently-defaulting-to-fast)

## User behavior

Codex Chat defaults to Standard. When Codex exposes additional speeds for the selected model, Chat gives the user an explicit speed choice. Fast and other faster tiers can consume more of the connected OpenAI subscription allowance.

Prior Chat versions could save Fast without the user's choice. Those saved options do not establish intent. When a legacy Chat is opened or a legacy client sends another turn, use Standard until the user picks a paid speed again.

## Execution contract

- The native Codex model catalog identifies available paid speed tiers. The Chat catalog and admission path enforce the explicit choice.
- A Standard request clears an inherited paid tier. Native app-server omission can restore the previous tier, so the outgoing start, resume and turn requests must distinguish Standard from omission where the provider caches the setting.
- The user's existing Chat, model selection, reasoning effort, account binding and conversation history remain usable when speed changes.
- Existing owner authorization and provider admission continue to govern execution. No new endpoint, grant, storage table or file is required.

## Verification

Exercise new Chats, legacy saved Fast, explicit Fast, and the switch back to Standard during a warm continuation and after thread resume. Check the resulting app-server request and the visible composer setting. Cover Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile on eligible builds.

Update the public Coding Agents guide alongside the product change.
