# Documentation Update Note

Public documentation updates for this feature should cover:

- Trusted single-user/container identity uses Matrix OS platform-controlled runtime configuration.
- `MATRIX_USER_ID` is the configured user id for new request-principal resolution.
- `dev-default` is local-development only and requires auth disabled, production false, and no configured identity.
- Protected route failures must stay generic to clients while detailed diagnostics remain server-side.

Planned targets:

- `www/content/docs/deployment/vps-per-user.mdx`
- `www/content/docs/developer/architecture.mdx`
