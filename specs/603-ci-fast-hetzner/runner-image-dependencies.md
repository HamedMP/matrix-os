# Runner image dependencies

The first isolated Linux unit benchmark exposed two runner-image gaps:
preview workflow shell tests execute `jq`, and golden-host certification tests
execute `/usr/bin/python3 -I -c 'import cryptography'`. The affected tests and
host/workflow scripts are unchanged from the reviewed product baseline.

Install Ubuntu `jq` and `python3-cryptography` in the benchmark image and check
both during image build. Preserve all test assertions and the existing
non-root, read-only, bounded-container isolation.

The process-group cleanup unit test also exposed orphaned subprocess zombies
under the keepalive `sleep` PID1. Start containers with Docker's `--init` so
exited orphaned children are reaped; keep the existing bounded keepalive and
artifact collection order.

Validation: reproduce the missing commands in the original image, rebuild,
then run the complete `golden-snapshot-host-scripts`,
`preview-collaboration-workflows`, `private-preview-workflow`,
`ai-credit-deployment`, and `speech-local-fixture` unit suites
before measuring the complete optimized stack. Record the new image digest;
before/after timing comparisons must use the same image.

Public documentation: update the dedicated Linux runner prerequisites in the
separate `FinnaAI/matrix-os-site` testing guide PR. Automatic CI dispatch stays
disabled until the stack is reviewed, merged, and the host key is verified.
