# Spec 055: Deployment Scaling

## Overview

Scale Matrix OS from a single Hetzner VPS to a multi-node architecture that automatically provisions new VPS instances when capacity is reached. Each node runs user containers; a control plane manages node health, container placement, and capacity.

## Current State

**Single node (Hetzner CPX21):**
- 3 vCPU, 4 GB RAM, ~5 EUR/mo
- Per container: 1 GB RAM, 0.5 CPU
- Max ~10 concurrent users (with 30-min idle auto-stop)
- `MAX_RUNNING_CONTAINERS` env var (default 20, includes stopped)
- Platform services: platform:9000, proxy:8080, conduit:6167, cloudflared
- All containers on one Docker daemon
- No `node_id` in schema, no multi-node logic

**What works well (keep):**
- Cloudflare tunnel (outbound-only, no public ports)
- Platform subdomain router (`{handle}.matrix-os.com` -> container)
- Proxy usage tracking and quotas
- Container lifecycle manager (idle stop after 30 min)
- Port allocation via platform DB

## Goals

- Support 100+ concurrent users across multiple VPS nodes
- Auto-provision new nodes when existing capacity is exhausted
- Zero-downtime node additions (no restart of control plane)
- Container placement: prefer the least-loaded node
- Node failure: detect and recover (restart containers on healthy nodes)
- Cost-efficient: stop idle nodes with no running containers
- Maintain single control plane (platform + proxy + conduit on node 0)

## Non-Goals

- Geographic distribution / multi-region (single Hetzner DC for now)
- Container migration between nodes (destroy + re-provision is fine)
- Kubernetes / Nomad (stay with Docker + custom orchestrator)
- Auto-scaling down mid-session (only scale down idle nodes)

## Architecture

### Node Topology

```
Control Plane (Node 0 - always running)
  platform:9000    -- orchestrator + subdomain router
  proxy:8080       -- shared API proxy + usage tracking
  conduit:6167     -- Matrix homeserver
  cloudflared      -- Cloudflare tunnel
  user containers  -- Node 0 also hosts users

Worker Node 1
  Docker API (TLS, private network)
  user containers

Worker Node 2
  Docker API (TLS, private network)
  user containers

...
```

### Control Plane vs Workers

**Control plane (node 0):** Runs all platform services + can host user containers. Always on.

**Worker nodes:** Run only user containers + a lightweight agent for health reporting. Can be stopped when empty (all containers idle and stopped).

### Network

All nodes in the same Hetzner private network (vSwitch or cloud network). Docker API on workers is only reachable via private IPs (not public internet).

- Control plane -> Worker: Docker API over TLS on private network
- Worker containers -> Control plane: proxy at `http://{node0-private-ip}:8080`
- External traffic -> Cloudflare tunnel -> platform:9000 -> routes to correct node/container

## Schema Changes

### New: `nodes` Table

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,          -- e.g., "node-0", "node-1"
  hetzner_server_id INTEGER,    -- Hetzner API server ID (for lifecycle management)
  private_ip TEXT NOT NULL,      -- Private network IP
  public_ip TEXT,                -- Public IP (for SSH access, not traffic)
  docker_port INTEGER DEFAULT 2376,
  status TEXT DEFAULT 'provisioning',  -- provisioning | ready | draining | offline
  server_type TEXT DEFAULT 'cpx21',    -- Hetzner server type
  max_containers INTEGER DEFAULT 10,   -- Capacity based on server_type
  running_containers INTEGER DEFAULT 0, -- Current running count (denormalized)
  total_memory_mb INTEGER,       -- Total RAM
  available_memory_mb INTEGER,   -- Remaining after running containers
  created_at TEXT DEFAULT (datetime('now')),
  last_heartbeat TEXT            -- Updated by node agent
);
```

### Modified: `containers` Table

Add column:
```sql
node_id TEXT REFERENCES nodes(id) DEFAULT 'node-0'
```

All existing containers get `node_id = 'node-0'` via migration.

### Node Status Transitions

```
provisioning -> ready -> draining -> offline
                  ^                    |
                  +--------------------+  (can be re-provisioned)
```

- `provisioning`: Hetzner API creating server, Docker being configured
- `ready`: accepting new containers
- `draining`: no new containers, waiting for existing to stop
- `offline`: server stopped or destroyed

## Container Placement

When `POST /containers/provision` is called:

1. Query `nodes` table for nodes with `status = 'ready'`
2. Sort by `available_memory_mb` descending (most headroom first)
3. Check if best node has capacity: `running_containers < max_containers` AND `available_memory_mb >= 1024`
4. If yes: place container on that node
5. If no node has capacity: trigger auto-provision (see below)
6. Update `running_containers` and `available_memory_mb` on placement

Placement is a single DB transaction: check capacity + insert container + update node counters.

## Auto-Provisioning New Nodes

### Trigger

When no node has capacity for a new container:
- All nodes at `max_containers` or `available_memory_mb < 1024`
- Provisioning request is queued (not rejected)

### Provisioning Flow

1. Platform calls Hetzner API: `POST /servers` with:
   - `server_type`: `cpx21` (default, configurable)
   - `image`: Ubuntu 24.04 or custom snapshot with Docker pre-installed
   - `location`: `nbg1` (Nuremberg, same as node 0)
   - `networks`: attach to private network
   - `ssh_keys`: platform SSH key for initial setup
   - `user_data`: cloud-init script that installs Docker, configures TLS, starts node agent

2. Insert `nodes` record with `status: 'provisioning'`

3. Cloud-init script on new node:
   - Install Docker Engine
   - Configure Docker TLS (CA cert from control plane, server cert/key)
   - Start node agent (lightweight HTTP service for health reporting)
   - Signal readiness to control plane via `POST /nodes/ready` callback

4. Platform receives ready callback:
   - Verify Docker API reachable over private network
   - Update node `status: 'ready'`
   - Place queued container on new node

### Hetzner API Integration

New file: `packages/platform/src/hetzner.ts`

```typescript
interface HetznerClient {
  createServer(opts: CreateServerOpts): Promise<{ serverId: number; privateIp: string }>
  deleteServer(serverId: number): Promise<void>
  getServer(serverId: number): Promise<ServerStatus>
  listServers(): Promise<ServerStatus[]>
}
```

Auth: `HETZNER_API_TOKEN` env var. All calls with `AbortSignal.timeout(30_000)`.

### Server Type Capacity Map

| Hetzner Type | vCPU | RAM | Max Containers | Cost/mo |
|-------------|------|-----|----------------|---------|
| cpx21 | 3 | 4 GB | 3 | ~5 EUR |
| cpx31 | 4 | 8 GB | 6 | ~9 EUR |
| cpx41 | 8 | 16 GB | 14 | ~17 EUR |

Max containers = `floor((RAM_GB - 1) / 1)` (reserve 1 GB for OS + Docker overhead, 1 GB per container).

Default: `cpx21` for cost efficiency. Configurable via `DEFAULT_NODE_TYPE` env var.

## Multi-Node Docker Client

### Dockerode Per Node

Currently: single `new Docker()` connecting to local socket.

Change: maintain a `Map<nodeId, Docker>` where each client connects to a node's Docker API over TLS.

```typescript
// Node 0 (local)
new Docker({ socketPath: '/var/run/docker.sock' })

// Remote nodes
new Docker({
  host: node.privateIp,
  port: node.dockerPort,
  ca: fs.readFileSync('/data/tls/ca.pem'),
  cert: fs.readFileSync('/data/tls/client-cert.pem'),
  key: fs.readFileSync('/data/tls/client-key.pem'),
})
```

New Docker clients are created when a node transitions to `ready` and removed when `offline`.

### Container Operations on Remote Nodes

All existing orchestrator operations (`createContainer`, `startContainer`, `stopContainer`, `removeContainer`) must accept a `nodeId` parameter and route to the correct Docker client.

The subdomain router in `platform/src/main.ts` must:
1. Look up container's `node_id` from DB
2. Route traffic to `http://{node.privateIp}:{containerPort}` instead of `localhost:{containerPort}`
3. Cache node IP lookups (invalidate on node status change)

## Node Health Monitoring

### Node Agent

Lightweight HTTP service running on each worker node. Reports:

```
GET /health
{
  "nodeId": "node-1",
  "dockerAlive": true,
  "runningContainers": 5,
  "memoryUsedMb": 3200,
  "memoryTotalMb": 4096,
  "cpuPercent": 45,
  "diskUsedPercent": 60,
  "uptimeSeconds": 86400
}
```

### Platform Health Check Loop

Every 30s, platform polls each node's health endpoint:
- Update `last_heartbeat`, `running_containers`, `available_memory_mb` in DB
- If 3 consecutive failures (90s): mark node `offline`
- If node `offline` with running containers: alert (containers need manual recovery or re-provisioning)

### Container Recovery on Node Failure

When a node goes `offline`:
1. Mark all containers on that node as `status: 'stopped'`
2. Do NOT auto-migrate (data is on the failed node's disk)
3. Alert admin via webhook/email
4. If node comes back: containers resume from their volumes
5. If node is permanently lost: admin triggers re-provision of affected users (new container, data lost unless backed up)

Future: replicated volumes or backup-to-S3 for recovery. Out of scope for v1.

## Scaling Down

### Idle Node Detection

Lifecycle manager (already runs every 5 min) extended:
1. After stopping idle containers, check each node
2. If a worker node has 0 running containers for 30+ min: mark `draining`
3. `draining` node: no new containers placed, wait for any remaining to stop
4. Once 0 containers: mark `offline`, call Hetzner API to stop server (not delete -- keeps disk)
5. Stopped servers cost nothing on Hetzner (only disk storage, ~0.50 EUR/mo per 40GB)

### Re-activating a Stopped Node

When capacity is needed and a stopped node exists:
1. Call Hetzner API to start server (faster than provisioning new: ~30s vs ~2 min)
2. Wait for node agent health check
3. Mark `ready`
4. Place container

Prefer re-activating stopped nodes over provisioning new ones.

## Subdomain Routing Changes

Current: platform routes `{handle}.matrix-os.com` to `localhost:{port}`.

New: platform routes to `{nodePrivateIp}:{port}`.

```typescript
// Current
const target = `http://localhost:${container.port}`

// New
const node = nodeCache.get(container.nodeId)
const target = `http://${node.privateIp}:${container.port}`
```

Node IP cache invalidated on node status changes. Fallback: DB lookup on cache miss.

## Volume Management

### Current

User data at `/data/users/{handle}/matrixos` on the platform VPS.

### Multi-Node

Each node stores its containers' data locally: `/data/users/{handle}/matrixos` on the worker node's disk.

This means:
- A container is tied to its node (data locality)
- Moving a container between nodes requires copying the volume (not in v1)
- Node loss = data loss for containers on that node (backup strategy is future work)

### Hetzner Block Storage (Optional)

For larger deployments, attach Hetzner block storage volumes to nodes:
- Network-attached, survives server rebuild
- Can be detached and re-attached to a different server (enables future migration)
- Cost: ~0.05 EUR/GB/mo

Not required for v1 but documented as upgrade path.

## Security

- **Docker TLS**: All remote Docker API connections use mutual TLS. CA cert generated by platform, distributed to nodes via cloud-init.
- **Private network**: Docker API only on private IPs, not reachable from internet.
- **SSH**: Platform SSH key for initial setup only. No ongoing SSH access needed (Docker API for operations).
- **Hetzner API token**: Stored as `HETZNER_API_TOKEN` env var on control plane only. Never in containers.
- **Node agent**: Listens on private network only, no auth needed (private network is trusted).
- **Firewall**: Hetzner firewall rules per node: allow SSH (22) from admin IP, allow private network, deny all other inbound.

## Resource Management

- **Max nodes**: configurable via `MAX_NODES` env var (default 10). Hard cap to prevent runaway costs.
- **Max containers per node**: derived from server type (see capacity map). Hard cap in DB.
- **Provisioning queue**: max 5 queued requests. Beyond that, return 503 with "capacity full, try again later."
- **Provisioning timeout**: if new node not ready within 5 min, mark `offline`, alert admin, reject queued requests.
- **Cost tracking**: platform logs node hours. Exposed via `/metrics` for Prometheus.

## Configuration

New env vars (control plane only):
- `HETZNER_API_TOKEN` -- Hetzner API authentication
- `HETZNER_SSH_KEY_ID` -- SSH key ID for new servers
- `HETZNER_NETWORK_ID` -- Private network ID
- `HETZNER_LOCATION` -- DC location (default `nbg1`)
- `DEFAULT_NODE_TYPE` -- Server type for new nodes (default `cpx21`)
- `MAX_NODES` -- Hard cap on total nodes (default 10)
- `NODE_IDLE_TIMEOUT_MIN` -- Minutes before stopping empty node (default 30)
- `DOCKER_TLS_CA_PATH` -- Path to CA cert for Docker TLS
- `DOCKER_TLS_CERT_PATH` -- Path to client cert
- `DOCKER_TLS_KEY_PATH` -- Path to client key

## Observability

Extend existing Prometheus metrics:
- `matrixos_nodes_total{status}` -- gauge per status
- `matrixos_node_containers{node_id}` -- gauge per node
- `matrixos_node_memory_available_mb{node_id}` -- gauge per node
- `matrixos_node_provision_duration_seconds` -- histogram
- `matrixos_node_provision_failures_total` -- counter
- `matrixos_capacity_queue_depth` -- gauge

Extend Grafana dashboards:
- Node overview: status, containers, memory, CPU per node
- Capacity timeline: containers over time, auto-provision events
- Cost tracking: node-hours, estimated monthly cost

## Migration Path

### Phase 1: Schema + Multi-Docker Client
- Add `nodes` table and `node_id` column to `containers`
- Migrate existing containers to `node_id = 'node-0'`
- Insert `node-0` record pointing to local Docker socket
- Orchestrator uses `Map<nodeId, Docker>` but only has one entry
- Subdomain router uses node IP lookup (localhost for node-0)
- **Zero behavior change** -- everything works as before, just through the new abstraction

### Phase 2: Hetzner Integration + Auto-Provision
- Add Hetzner API client
- Cloud-init script for worker node setup
- Docker TLS cert generation and distribution
- Provisioning flow: create server -> wait for ready -> place container
- Node health monitoring loop

### Phase 3: Scale Down + Cost Optimization
- Idle node detection and auto-stop
- Re-activate stopped nodes before provisioning new ones
- Cost tracking metrics
- Admin dashboard: node list, capacity, cost estimates

### Phase 4: Reliability
- Container recovery on node failure
- Alerting for offline nodes
- Volume backup strategy (future)
- Multi-region support (future)

## Integration with Spec 053 (Onboarding)

The onboarding flow calls `POST /containers/provision`. If no node has capacity:
1. Platform queues the request (max 5 in queue)
2. Auto-provisions a new node
3. Once ready, places the container and returns
4. Onboarding WS receives a provisioning delay message
5. Shell shows "Setting up your space..." with a slightly longer animation

If provisioning queue is full (503), the onboarding flow shows: "We're at capacity right now. We'll notify you when your space is ready." -- stores email for notification.

## Dependencies

- Hetzner Cloud API (well-documented, stable)
- Docker Engine with TLS (standard setup)
- cloud-init (standard on Hetzner images)
- Existing platform orchestrator (extended, not replaced)
- Existing Prometheus/Grafana stack (extended)
