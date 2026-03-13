# Deploy Status

Show the state of the entire production deployment.

## Steps

1. Check local git state:
   - Current branch and tag: `git describe --tags --always`
   - Unpushed commits: `git log @{u}..HEAD --oneline`

2. Check CI/CD:
   - Latest workflow runs: `gh run list --limit 5`
   - Docker image build status: `gh run list --workflow=docker.yml --limit 3`

3. Check production services (via platform API or SSH):
   - Platform health: `GET https://api.matrix-os.com/health`
   - Proxy health: check proxy endpoint
   - Admin dashboard: `GET /admin/dashboard` for container counts and status

4. Container overview:
   - Total containers, running vs stopped
   - Any unhealthy containers
   - Image version drift (are all containers on the latest image?)

5. Present a summary table:
   ```
   Service       Status    Version
   ---------     ------    -------
   Platform      healthy   v0.3.0
   Proxy         healthy   v0.3.0
   Containers    12/15 running
   CI            passing
   Last deploy   2h ago
   ```

6. Flag any issues: unhealthy services, version drift, failing CI, containers stuck in stopped state.

## Environment

- VPS host: configured via SSH config or `VPS_HOST` env var
- Platform API: `https://api.matrix-os.com` (or `PLATFORM_API_URL`)
- Platform secret: `PLATFORM_SECRET` in `.env` or `.env.docker`
