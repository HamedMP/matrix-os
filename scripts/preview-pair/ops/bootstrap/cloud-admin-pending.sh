#!/usr/bin/env bash
# Two exact, requester-approved bindings that require a Cloud IAM administrator.
# Prepared only. Do not broaden this operator's permissions to execute them.
set -euo pipefail
project=matrix-os-1144
subject='repo:HamedMP/matrix-os:environment:collaboration-preview-control'
provider='projects/515970864382/locations/global/workloadIdentityPools/matrix-pair-preview/providers/github'
expected="assertion.repository == 'HamedMP/matrix-os' && assertion.ref == 'refs/heads/preview-pair-controller/bc47e8e3623898f83c946d13f0689e572b9a3821' && assertion.workflow_ref == 'HamedMP/matrix-os/.github/workflows/preview-collaboration-pair.yml@refs/heads/preview-pair-controller/bc47e8e3623898f83c946d13f0689e572b9a3821' && assertion.sub == '$subject'"
actual=$(gcloud iam workload-identity-pools providers describe github --project "$project" \
  --location global --workload-identity-pool matrix-pair-preview --format='value(attributeCondition)')
[[ "$actual" == "$expected" ]] || { echo 'Provider condition differs from the reviewed pin; stop.' >&2; exit 1; }
gcloud iam service-accounts add-iam-policy-binding \
  "matrix-pair-preview-publisher@$project.iam.gserviceaccount.com" --project "$project" \
  --member="principal://iam.googleapis.com/projects/515970864382/locations/global/workloadIdentityPools/matrix-pair-preview/subject/$subject" \
  --role=roles/iam.workloadIdentityUser --format=none
gcloud iam service-accounts add-iam-policy-binding \
  "matrix-pair-preview-runtime@$project.iam.gserviceaccount.com" --project "$project" \
  --member="serviceAccount:matrix-platform-runner@$project.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountUser --format=none
echo 'Exact pending service-account bindings applied; verify effective isolation before Source activation.'
