# Portable bounded staging sweep test

The existing Linux test failed after three cleanup passes because filesystem
iteration placed the original workspace after the other 128 workspaces. The
production sweeper visits at most 128 workspaces per pass and 256 staging entries
per workspace visit. This fixture contains 129 workspaces and 257 stale files in
the original workspace, so that workspace needs two visits. If it is last, those
visits happen on passes two and four; three passes leave one stale file.

Allow four bounded passes and explain the two workspace rounds in the test.
Retain every existing assertion and all eight tool-dispatcher test cases.
Production sweep limits, continuation cursors, TTL, and symlink behavior are
unchanged. The observed Linux failure provides the red case; rerun the complete
tool-dispatcher suite locally and on the pinned Linux image for green validation.

This corrects a test's filesystem-order assumption, not public product behavior.
The companion CI testing guide is tracked in
[matrix-os-site #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
