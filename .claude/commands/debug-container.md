# Debug Container

Diagnose a customer's container by handle. Usage: `/debug-container <handle>`

The handle is: $ARGUMENTS

## Steps

1. Determine the environment:
   - If running locally (Docker dev): use `docker` commands directly
   - If targeting production: use `ssh` to VPS or platform API at `https://api.matrix-os.com`

2. Query container status:
   - Platform API: `GET /containers/<handle>` (with `Authorization: Bearer $PLATFORM_SECRET` if needed)
   - If not found, report and stop

3. If container is stopped:
   - Report last active time
   - Ask if user wants to start it: `POST /containers/<handle>/start`

4. If container is running, run diagnostics:
   - **Health**: `docker exec matrixos-<handle> wget -qO- http://localhost:4000/health`
   - **Resources**: `docker stats matrixos-<handle> --no-stream`
   - **Recent logs**: `docker logs matrixos-<handle> --tail 100`
   - **Home dir**: `docker exec matrixos-<handle> ls -la /home/matrixos/home/system/`
   - **Interaction logs**: check `/home/matrixos/home/system/logs/` for recent entries

5. Parse logs for common error patterns:
   - `ECONNREFUSED` -- gateway or shell crashed
   - `Claude Code process exited` -- kernel crash (check if running as root)
   - `OOMKilled` -- memory limit exceeded
   - `ENOSPC` -- disk full
   - `TypeError` / `ReferenceError` -- code bug in gateway/kernel

6. Present structured diagnosis:
   - Container: status, uptime, image version
   - Health: gateway, shell, kernel
   - Resources: CPU, memory, disk
   - Errors: recent error patterns with timestamps
   - Recommendation: restart, upgrade, increase memory, investigate specific error

7. If user wants to take action (restart, stop, upgrade, destroy), confirm before executing.

## API Reference

- Platform API base: `http://localhost:9000` (local) or `https://api.matrix-os.com` (prod)
- Container name pattern: `matrixos-<handle>`
- Data dir: `/data/users/<handle>/matrixos/` (VPS) or Docker volume (local)
- Platform DB: `/data/platform/platform.db`
