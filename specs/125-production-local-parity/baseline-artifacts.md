# ENG-100 production artifact baseline

This temporary validation branch preserves all production inputs from main commit `ff49b2131731093c1583d1984903702bf4a76b0e`. This note is outside the host-bundle payload. No application, build, runtime, dependency, or deployment configuration is changed.

[ENG-100](https://linear.app/matrix-os/issue/ENG-100/review-pr-2040-run-the-production-host-topology-locally) uses the supported bundle-only preview workflow to build and register comparison artifacts with channel `none`. Do not provision a VPS, promote an update channel, or merge this branch.

Compare normalized artifacts with the candidate in native stack #2882 (PR #2880 → #2881), preserving actual content differences and excluding only documented build metadata. Fork PR #2040 remains the historical reference.
