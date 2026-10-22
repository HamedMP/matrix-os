# Temporary platform object-storage credentials

Platform sync and host-bundle object clients accept an optional session token
alongside their access key and secret key. The AWS SDK includes it in signed
requests and presigned URLs. Permanent two-part credentials behave as before.

Use `R2_SESSION_TOKEN` with `R2_ACCESS_KEY_ID`, or `S3_SESSION_TOKEN` when
`S3_ACCESS_KEY_ID` is selected. Dedicated bundle credentials use
`R2_BUNDLES_SESSION_TOKEN` or `S3_BUNDLES_SESSION_TOKEN` independently. Explicit
credentials never inherit `AWS_SESSION_TOKEN`, another family's token, or the
primary storage token when dedicated bundle credentials exist. Existing bucket,
endpoint, key precedence and whole-primary-client fallback remain unchanged.

For short-lived Cloudflare R2 access, each temporary credential is scoped to one
bucket. Keep the parent credential in the trusted operator process and pass only
the appropriate child triple to each named platform storage configuration.
Use the correct jurisdiction endpoint. Credential expiry is enforced by R2;
this static configuration does not silently refresh or extend it. Stop the
isolated service and complete cleanup within the approved window. Presigned URLs
remain bearer capabilities and must not be logged or published as test evidence.

This change covers the platform sync and bundle clients only. It does not add
session-token support to direct Gateway storage, account-deletion storage or the
standalone release publisher. Customer VPS sync through the platform broker
continues to receive scoped runtime authority, not object-store credentials.
No token, resource or permission is created by configuring this optional field.

Tracking: [ENG-124](https://linear.app/matrix-os/issue/ENG-124/complete-whatsapp-reactions-and-production-launch-acceptance).
Companion public documentation deliverable: update the existing Messaging setup
guide documentation PR when temporary isolated acceptance is qualified; retain
the operational credential policy here without private deployment details.

References: [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
and [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).
