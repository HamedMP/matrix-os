# Deploy Status

Show the state of the entire production deployment.

## Steps

1. Check local git state:
   - Current branch and tag: `git describe --tags --always`
   - Unpushed commits: `git log @{u}..HEAD --oneline`

2. Check CI/CD:
   - Latest workflow runs: `gh run list --limit 5`
   - Customer runtime bundles: `gh run list --workflow=host-bundle-release.yml --limit 3`
   - Platform control plane: `gh run list --workflow=platform-cloud-run.yml --limit 3`

3. Check production services through the platform API:
   - Platform health: `GET https://api.matrix-os.com/health`
   - Proxy health: check proxy endpoint
   - Fleet state: `GET /vps/fleet` for customer VPS health and runtime versions

4. Customer VPS overview:
   - Total customer machines, healthy vs unhealthy
   - Promoted host-bundle version and channel
   - Runtime version drift from the promoted bundle

5. Present a summary table:
   ```
   Surface          Status    Version
   ---------------  --------  -------
   Platform         healthy   <revision>
   Proxy            healthy   <revision>
   Customer fleet   15/15     <bundle version>
   CI               passing
   Last deploy      2h ago
   ```

6. Flag any issues: unhealthy services, runtime version drift, failing CI, or
   customer machines stuck in a transitional state.

## Environment

- Platform API: `https://api.matrix-os.com` (or `PLATFORM_API_URL`)
- Platform authentication: use the configured operator credentials; never print secrets
