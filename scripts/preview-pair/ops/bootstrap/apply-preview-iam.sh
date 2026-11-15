#!/usr/bin/env bash
# Bootstrap/recovery only. Review scopes below and ../README.md before applying.
set -euo pipefail
[[ "${1:-}" == --apply ]] || { echo 'Review ../README.md and exact scopes below; use --apply only after authorization.'; exit 1; }
phase="${2:-all}"
[[ "$phase" == all || "$phase" == publisher || "$phase" == runtime || "$phase" == runtime-secrets ]] || { echo 'Unknown IAM phase.' >&2; exit 1; }
project=matrix-os-1144
number=515970864382
region=europe-west3
pin=bc47e8e3623898f83c946d13f0689e572b9a3821
branch="refs/heads/preview-pair-controller/$pin"
runtime="matrix-pair-preview-runtime@$project.iam.gserviceaccount.com"
publisher="matrix-pair-preview-publisher@$project.iam.gserviceaccount.com"
source="matrix-platform-runner@$project.iam.gserviceaccount.com"
pool=matrix-pair-preview
subject='repo:HamedMP/matrix-os:environment:collaboration-preview-control'
condition="assertion.repository == 'HamedMP/matrix-os' && assertion.ref == '$branch' && assertion.workflow_ref == 'HamedMP/matrix-os/.github/workflows/preview-collaboration-pair.yml@$branch' && assertion.sub == '$subject'"
secrets=(clerk-secret database-url platform-secret jwt-secret edge-secret ticket-keys)
# Runtime/Source grants remain gated on all six exact references. The independent
# publisher phase can be prepared while database provisioning is pending.
if [[ "$phase" != publisher ]]; then
  for suffix in "${secrets[@]}"; do
    gcloud secrets versions describe 1 --secret="matrix-pair-preview-$suffix" \
      --project "$project" --format='value(state)' | rg -q '^ENABLED$'
  done
fi
if [[ "$phase" == all || "$phase" == publisher ]]; then
gcloud iam workload-identity-pools create "$pool" --project "$project" \
  --location global --display-name='ENG-418 preview pair'
gcloud iam workload-identity-pools providers create-oidc github --project "$project" \
  --location global --workload-identity-pool "$pool" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition="$condition"
gcloud iam service-accounts add-iam-policy-binding "$publisher" --project "$project" \
  --member="principal://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$pool/subject/$subject" \
  --role=roles/iam.workloadIdentityUser --format=none
gcloud artifacts repositories add-iam-policy-binding matrix-pair-preview \
  --project "$project" --location "$region" --member="serviceAccount:$publisher" \
  --role=roles/artifactregistry.writer --format=none
fi
if [[ "$phase" != publisher ]]; then
for suffix in "${secrets[@]}"; do
  for actor in "$runtime" "$source"; do
    gcloud secrets add-iam-policy-binding "matrix-pair-preview-$suffix" --project "$project" \
      --member="serviceAccount:$actor" --role=roles/secretmanager.secretAccessor --format=none
  done
done
gcloud secrets add-iam-policy-binding matrix-pair-preview-operator-secret --project "$project" \
  --member="serviceAccount:$source" --role=roles/secretmanager.secretAccessor --format=none
if [[ "$phase" != runtime-secrets ]]; then
  gcloud iam service-accounts add-iam-policy-binding "$runtime" --project "$project" \
    --member="serviceAccount:$source" --role=roles/iam.serviceAccountUser --format=none
fi
fi
echo "Requested $phase IAM phase applied. Audit effective inherited grants and test isolation before Source activation."
