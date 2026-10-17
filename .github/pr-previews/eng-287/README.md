# ENG-287 synthetic account export evidence

Captured October 14, 2026 from the changed platform `account-deletion/page.ts`, real account routes and record exporter, against an isolated local PostgreSQL 16 database. 205 synthetic posts; no customer data, customer exports or deletion requests. Auth is a fixture bearer verifier plus injected Clerk session; object inventory/download transport is a synthetic local fixture. These captures do not prove real Clerk authentication, deployed S3/R2 credentials or backup freshness.

- 375, 768 and 1280 px: real rendered account utility page, source timestamps/sizes, no document horizontal overflow.
- Video: three numbered JSON page downloads, one failed continuation and retry, final completion.
- Downloaded JSON pages contained 205 distinct post IDs without omission/duplication.
- Downloaded custom-format snapshot through the account inventory link; restored with `pg_restore --no-owner --no-privileges` into a clean isolated PostgreSQL database. Two synthetic `owner_notes` rows matched source exactly. SHA-256: `3b6e22589ab3dc356a6d37aae8162385ce5c10efbe823bdbc9c7a51ec439084b`.

Web account utility behavior is captured at desktop/tablet/phone viewports. These captures are not Web Canvas entry-point, packaged Electron Desktop, Native Mobile device, or authenticated production evidence. Native Mobile request/hook/file/screen tests cover its code; device evidence remains pending. Website responsive/full-build qualification remains pending in the companion docs PR.
