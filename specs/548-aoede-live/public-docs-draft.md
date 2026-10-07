# Aoede voice preview — public documentation draft

**Editorial status: do not publish.** Prepared for separate delivery to `FinnaAI/matrix-os-site/content/docs/`; no site files or deployment are changed here. Aoede Live is an unqualified, hidden-by-default development preview. Existing voice functionality remains in place. Do not describe Live as generally available, a completed replacement, or production-ready. Remove this editorial notice only after provider/browser/billing qualification and explicit publication approval.

## Talk to your Matrix computer

Aoede is a voice preview for the web Desktop and Canvas experience. When the preview is enabled for your environment, open **Aoede** from the dock and choose **Start fresh session**. Opening the panel does not start a paid voice connection. Your browser asks for microphone access before starting the session.

Use a secure browser connection, a working microphone and speakers or headphones. If microphone access is blocked, allow it in your browser's site permissions and start fresh. There is no wake-word or automatic reconnection. Availability on native mobile and packaged desktop applications has not been established.

While connected, you can speak, see captions and ask Aoede to open an installed app, work with Notes, remember a preference, or help with a task. Direct actions currently recognize a limited English transcript grammar; speech recognition and punctuation can affect matching. More general requests go through Chat. Ambiguous app names or note edits may need clarification. Check the actual app or note rather than treating spoken narration as confirmation of a change.

Choose **End session**, close the panel or press Escape to stop local microphone capture and playback and request closure of the voice connection. Closing the panel does not cancel a task already running in Chat.

## Tasks and permission requests

Longer work is handled in the durable **Aoede** Chat. Task cards show queued/running work and requests for permission. You can inspect results and manage work in Chat even after ending voice.

Voice does not give Aoede unlimited permission. A spoken yes/no is eligible only for one current, explicitly low-risk permission request that was presented in that session. Higher-risk or unclear requests require an explicit interface decision. Use **Allow once** or **Deny** where offered; there is no voice permission grant for the whole session.

Use **Cancel task** on the relevant card to request cancellation. If several tasks are active, select the one you mean rather than relying on an ambiguous “stop.” Cancellation may take time; inspect Chat for the final outcome. If a permission submission is not confirmed, retry the same decision or check Chat before changing it.

## Voice usage and your balance

Voice uses the existing Matrix funding balance, not a separate Aoede wallet. Your environment's policy determines eligible credits and speech allowance. A session reserves enough eligible balance for its configured maximum duration plus startup and finalization headroom before connecting. A low balance or exhausted allowance can prevent a session from starting. Check the existing Billing interface for funding options.

Final voice charges depend on trusted service usage confirmation. A failed or interrupted connection after startup is not necessarily free. When final usage cannot be confirmed, the session may be charged conservatively and another session blocked until it can be reconciled. Contact support rather than repeatedly restarting to work around this condition. A local end-session timer is not a guaranteed spending cap during a service or network outage. No fixed public rate or free-preview promise is made by this draft.

## Saved text and interruptions

Matrix does not store voice audio for this preview. Audio is processed by the speech service during the connection; this statement does not replace that service's privacy/retention policy. A limited recent text checkpoint is saved on your computer for up to 24 hours to help start a fresh conversation. Recent speech may be missing after a failure. Chat history and remembered facts are separate and follow their existing retention rules.

Under **Conversation & privacy**, choose **Delete saved voice text** to remove the saved recovery checkpoint. This does not delete durable Chat history, remembered facts, billing records, or captions already visible in the open panel. Further speech can create new saved text.

After interruption, explicitly choose **Start fresh session** when the service is available. This starts a new connection with available saved text; it is not seamless resumption. Completed actions are not automatically repeated, and uncertain actions are not automatically retried. Recent task cards are restored from Chat when the new session is ready; this recovery path still needs live qualification. Check the Aoede Chat before repeating an uncertain request.

## If something goes wrong

- **Aoede is missing:** Live is hidden by default and only enabled in a development preview; it is not a standard available feature yet.
- **Start is disabled:** wait for your computer to reconnect and confirm you are signed in.
- **Microphone is blocked:** check browser and operating-system microphone permissions and use a secure connection.
- **Connection fails or ends:** restore network/device access and start explicitly; no automatic paid reconnect occurs. If another session cannot start, unresolved usage may require support.
- **No sound:** check output device and browser playback permissions. Caption arrival alone does not establish audible playback.
- **An action is unconfirmed:** inspect the app or durable Chat before retrying. An ambiguous target may need a more specific name.
- **Conversation text limit reached:** the connection ends rather than silently dropping earlier displayed captions; the recovery checkpoint retains less text than the full on-screen conversation.

## Publication handoff checklist (not public page content)

- Deliver via a separate site-repository PR only with authorization; do not publish from this branch.
- Resolve the local production-parity environment/preview wiring gap before describing a working production-parity test path.
- Obtain real paid provider evidence for duration/expiry/close, startup ordering, interruptions and final wallet accounting. Fixture tests are not live-service evidence.
- Verify Desktop/Canvas invocation, denied microphone, recovery, approval, cancellation, device/network failure and reduced-motion behavior in a browser.
- Qualify recovery-card/current-outcome restoration after restart. Verify owner export/deletion UX and clarify the distinction between saved checkpoint, facts and Chat history.
- Do not promise a price, language/device support, lossless recovery, provider retention guarantee or latency/reliability target without measured evidence and policy approval.
- Keep provider keys, internal runtime routes, machine identities, private transcripts and operator configuration out of the eventual public page.

Provider references for editorial verification: [session creation](https://developers.openai.com/api/reference/resources/live/methods/create), [sideband/no replay](https://developers.openai.com/api/reference/resources/live/sideband-websocket), [history/close](https://developers.openai.com/api/docs/guides/live-conversations), [billing](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live). These are the corrected implementation plan's references, not evidence that this preview has passed qualification.
