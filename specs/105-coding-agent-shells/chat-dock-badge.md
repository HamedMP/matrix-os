# Electron Desktop Dock badge and Chat history

The native Dock badge projects unread conversations from canonical Chat history,
showing a native red indicator without a number on macOS whenever any chat is unread,
using the same `isChatUnread` read-state interpretation as the history rail.
Legacy kernel threads and coding-agent attention summaries do not write the badge.

The application owns one subscription, independent of open, hidden, or minimized
Chat windows. Read-state events refresh the count; a 30-second retry handles missed
events and transient failures. Count all projects, independently of rail filters,
with at most ten 100-record pages and a native display cap of 999. Requests from a
previous runtime cannot apply results after teardown. Failed reads retain the last
known count; runtime/auth teardown clears it. No owner data or read markers are
changed by the badge itself.

This fixes native presentation of an existing shared capability. Web Canvas, Web
Desktop, and mobile retain their existing Chat read state; an Electron Dock is a
platform-specific surface. No new API or persistence is introduced.

Validation: focused badge and runtime wiring tests, legacy wiring regression,
existing Chat rail/controller tests, Electron typecheck/build, and an isolated
Electron fixture that checks the native badge label before and after opening Chat.
For Human Review, start with one unread fixture conversation, open Chat and select
“Dock badge review”; the native Dock dot should disappear after reading. macOS controls its size and shape.
