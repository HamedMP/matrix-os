# Native Host Control Compatibility

> Execute with subagent-driven-development. Controller owns actual target operations.

**Goal:** Make the native qualifier accurately test access denial and safely recognize empty systemd stop hooks on the qualified Linux host.

**Evidence:** The98feb86 Dev run passed placement, baselines, frozen dependencies/build, supervisor startup/capability/security and running worker identity. It stopped before SDK query on worker_file_not_denied; cleanup refused because systemctl omitted empty ExecStop/ExecStopPost. Per-run installed/peer invariance passed. Controller separately stopped/reset only the proven owned transient definition after D-Bus typed empty hooks and automatic-RuntimeMax restart ownership verification.

**Kernel spike:** In an equivalent isolated root, /root exists as a different tmpfs object with mode000. F_OK succeeds while R_OK and X_OK returnEACCES. Synthetic private canary and host.env areENOENT; installedhome isEACCES. No contents or credentials were read. D-Bus reports ExecStop and ExecStopPost each exactly a(sasbttttuii)0 on this host; systemctl show omits them even with --all.

## Global Constraints

- ReuseENG432/noTrellis, noMain/installedDev/productionledger/newVPS/merge/paidcall/messages. Preserve live85aa/localthreeworktrees and allfailedreceipts.
- Only harness/operatorhelpers and tests/docs, no fixedworkerprofile/security weakening. Preserve source/lock/compiled/Node FD identity, incarnation/definition/dependency guards and unknown-state refusal.
- Negative probes must distinguish denied readability from existence without reading credential/user content. Keep positivecontrols, allowedexplicitdenialerrnos, and timeout/unknownerrno failure. Never skip failed evidence or manufacture deniedresults.
- Missing CLI hook output is not zero. Require authoritative typed empty service properties for the exact proven unit before mutation; unsupported/malformed/mismatched/unit replacement/unknown fails closed. No broadserviceactions.
- Any added host dependency must be checked before launching candidates and documented. No unbounded buffers/registries/calls. PerPRhardcap50files/3000adds; aim20/1000. Singleimplementer only; site docs remain separate.

## Task 1: Repair access probe and authoritative hook observation

Own scripts/ops/devstack-native/{controls,ownership,control}.mjs plus a focused hook/helper module if needed, relevant native scripts tests and operating docs. Do not edit coreGateway/profile code.

1. Probe actual read permission with metadata-only filesystem APIs instead of F_OK. Cover an actual non-root private mode000directory: existencepositive but readnegative; allow genuinely readable syntheticpath to fail. Retain missingpath and unknownerrno/timeout negatives, positivebroker/network controls, and exact path/result binding. A helper reused by productionprobe and test is preferable to substring-only assertions.
2. Observe missing ExecStop/ExecStopPost through bounded systemd D-Bus properties (busctl present on qualifiedhost) or equally authoritative typed interface. Bind exact requestedunit/objectpath/service interface, validate emptyarraytype/count, preserve definition/incarnation around observation and never treat transport failure/emptystdout/unknownproperty as empty. Nonempty hooks remain quarantined. Add preflight dependency and compatibilitydocs if newCLI used. Existing lifecycle checks must still gate every mutation.
3. TDDcoveringtests for realnonrootaccessbehavior, omission→typedzero, nonempty/malformed/unavailable/otherunit/replaceddefinition refusal and actualcleanupcalls onlyafterproof; existingnativeownership/security/interruption/drainregressions. Run focusedtest/syntax/diffchecks, commitexplicitpaths, reportRED/GREENexactcommands/output.

Controller separately repeats frozen qualification on a fresh owned namespace, retaining originalstate/generation and immutablefailedreceipts. NativeSDK/isolation/restart/drain and connectedGateway acceptance are separate. No macOSfixture or metadata spike is a completed native pass.
