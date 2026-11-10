# S1 extension: AWS desk evaluation (research only, nothing created, no AWS CLI run)

All sources were read on 2026-11-10. [D] means AWS documentation or an AWS price list says it. [R] means a third party reports it (blog, GitHub issue). [I] means inferred. [U] means unverified, and each [U] is a measurement item in section 8.

Prices marked "price list" come from the public AWS Price List bulk files (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/<region>/index.json`, publication dates 2026-10-19 (ECS) and 2026-10-30 (Lambda)), fetched with curl. No account was used.

Two requirements found since the first report are treated as hard criteria here:
- **H-userns:** a non-root process inside the unit can create user namespaces (`unshare`, `clone(CLONE_NEWUSER)`, `mount`, `umount2`, `pivot_root`, `setns` not blocked). Docker's default seccomp fails this (S2).
- **H-pg:** raw TCP egress to one Postgres endpoint is allowed while everything else is denied (S5: direct connection, no pooler, 5 connections per owner).

## 0. Summary

- **One AWS option may pass every hard criterion on paper: Lambda MicroVMs** (launched 2026-06-22; eu-west-1 at launch, eu-central-1 since 2026-08-19). Each unit is a Firecracker VM. Images can be granted all Linux capabilities. The API has run, suspend, resume, and terminate. A VPC egress connector puts outbound traffic under security groups. **H-userns is still [U]**: no AWS page says it works. It is likely [I], because Docker is reported working inside and capabilities can be set to `ALL`.
- **ECS on Fargate very likely fails H-userns.** AWS documents no privileged mode, no CAP_SYS_ADMIN, and no `dockerSecurityOptions`, so there is no seccomp override. Rootless Podman is reported to fail with `cannot clone: Operation not permitted`. Fargate is the cheapest AWS line item, so a one-hour probe is worth running before discarding it.
- **Second deep candidate: our own microVMs on EC2 nested-virtualization instances**, either Firecracker with our own scheduler, or EKS with Kata. This passes by construction [I]. It is the AWS version of the Hetzner fallback, but billed hourly, elastic, and payable with credits.
- **Lambda functions, examined in depth (section 4a): fail as a unit host.**
  - The blockers: a 900 s cap, invocation-scoped execution with freezing, inbound WebSockets only through API Gateway (2 h cap, 10 min idle, 29 s integration timeout), and no user namespaces.
  - SnapStart for Node container images (since 2026-09) wakes in ~0.4-0.8 s [R], but only for request-scoped code.
  - Using it would force a stateless rewrite of the gateway and drop the Terminal.
- **Eliminated quickly:** App Runner, AgentCore Runtime, EKS Fargate, EKS Auto Mode, and ECS on shared EC2 (section 1).
- **Wake time under 5 s (section 7a), now the primary soft criterion:**

  | Option | Wake | Idle cost |
  |---|---|---|
  | **Lambda MicroVMs** | ~2-3 s [R] (resume an owner's own suspended MicroVM, or claim a suspended generic pool member and bind it) | ~$175/mo for the pool |
  | Self-run Firecracker restore on EC2 | under 1 s [I] | $1.4k-3.5k/mo of host headroom |
  | Fargate | 30-60 s cold; ~1-3 s with a running pool [I] | ~$1.4k/mo for the pool |
  | ECS/EC2 warm pools with hibernation | tens of seconds [I] | |
- **Cost at 100,000 instance-hours/month:**

  | Option | Compute | All-in incl. extras | Credit runway on $100k |
  |---|---|---|---|
  | Lambda MicroVMs, Ireland ARM, 1 vCPU/2 GB baseline | $13.3k | ~$16k | ~6 months |
  | Same, 1 GB/0.5 vCPU baseline with burst [I] | | ~$9.5k | ~10 months |
  | Fargate, if it passed | | ~$6.3k | ~16 months |
  | Cloud Run gen2 (first report, instance-based) | $7.9k | | cash |

## 1. Candidate triage

| Candidate | Verdict | Deciding evidence |
|---|---|---|
| **Lambda MicroVMs** | **Deep dive 1** | Firecracker VM per MicroVM; `additionalOsCapabilities: ["ALL"]`; suspend/resume; VPC egress connector ([images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html), [networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)) [D] |
| **EC2 nested-virt + Firecracker/Kata (ECS/EKS/own scheduler)** | **Deep dive 2** | Nested virtualization on non-metal C7i/C8i/M7i/M8i/R7i/R8i/I7i, no extra cost ([EC2 docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)) [D] |
| ECS on Fargate (+ Spot) | Likely fail H-userns; probe once | Section 4 |
| EKS with Fargate profiles | Same runtime limits as Fargate [I]; adds a $0.10/h control plane [U] | Same Fargate launch bucket ([throttling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/throttling.html)) [D] |
| EKS Auto Mode | Pods share the node kernel. A per-user VM boundary needs Kata, and Auto Mode's AWS-managed nodes give no custom runtime path [U]. Managed nodegroups now honour nested virt in launch templates ([roadmap #2784](https://github.com/aws/containers-roadmap/issues/2784), closed 2026-10-12) [R] | Use EKS managed nodegroups, not Auto Mode (deep dive 2) |
| ECS on shared EC2 | Fails isolation: shared kernel. `dockerSecurityOptions` has no seccomp value, only `no-new-privileges`, `apparmor`, `label`, `credentialspec` ([API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)) [D]. A daemon-wide seccomp file on a custom AMI is possible [I] | One task per instance gives a VM boundary, but cold start becomes EC2 boot plus image pull [U] |
| Lambda functions (Event Functions) | Fail as a unit host (see section 4a). The 900 s timeout, invocation-scoped execution and lack of inbound sockets force a gateway rewrite | SnapStart for containers is fast to wake (sub-second), but only for request-scoped code |
| Lambda Web Functions | Fail: shared, autoscaled environments; 2 vCPU/2 GB max; 30 s default request timeout (max 900 s); no PrivateLink ([quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)) [D] | |
| App Runner | Fail: closed to new customers from 2026-04-30 ([notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)) [D] | AWS points to ECS Express Mode (Fargate-based [I]) |
| Bedrock AgentCore Runtime (microVM) | Eliminated (see below) | |
| AgentCore Runtime "Instances" | EC2 instance per session with EBS kept across stops, 14-day max; EC2 price + 12% fee ([instances](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html), [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)) [D] | Same invoke-only contract; first invoke includes EC2 provisioning |

**Why AgentCore Runtime (microVM) is eliminated:**
- **Contract:** the container must serve only `POST /invocations`, `GET /ping` and `/ws` on one port, and must be ARM64 ([HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)) [D]. Our gateway's full HTTP surface would need tunnelling through `/invocations`.
- **Limits:** 2 GB image cap (hard), 2 vCPU/8 GB per session, 1 GB session storage, 60 min cap on streams and WebSockets, 8 h session cap ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) [D].
- **Environment:** described as a "restricted container" with no Docker daemon ([comparison](https://builder.aws.com/content/3HVfZMEUpgdnyUonIjpzQvdaHWX/lambda-microvms-vs-agentcore-runtime-when-to-use-each-for-production-agents)) [R]. H-userns is [U].
- **Not a blocker on its own:** price is attractive, because CPU is billed only when active (v1: $0.0895/vCPU-h, $0.00945/GB-h) [D].

## 2. Hard-criteria matrix (AWS deep dives, plus Fargate for reference)

| Criterion | Lambda MicroVMs | EC2 nested-virt microVMs (Firecracker or EKS+Kata) | ECS on Fargate |
|---|---|---|---|
| Isolation | **pass** [D]: "Firecracker virtualization", "VM-level isolation", "no shared kernel" ([blog](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)). App runs "as a container within the MicroVM operating system environment" (AL2023) ([images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)) | **pass** [I]: one KVM guest per user on L1 hypervisor; Nitro passes VT-x ([docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)) [D]. We own guest kernel and VMM security ([shared responsibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)) [D] | **pass** [D]: "each workload on an isolated virtual environment" ([security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)) |
| **H-userns** | **likely, [U]**. Default is "a standard set of Linux capabilities". `additionalOsCapabilities: ["ALL"]` enables "mounting filesystems, creating network namespaces, or running eBPF", applied "within the VM isolation boundary" [D]. Docker reported working inside [R] ([Steele](https://awsteele.com/blog/2026/06/23/some-notes-on-lambda-microvms.html)). Kernel version, `user.max_user_namespaces`, and inner-container seccomp are all undocumented [U]. [I] With CAP_SYS_ADMIN in the container's bounding set, a Docker-style profile allows the namespace syscalls for every process in the container, including non-root | **pass by construction** [I]: we choose guest kernel, sysctls and (no) seccomp | **likely FAIL** [D+R]: privileged unsupported; CAP_SYS_ADMIN "restricted"; only SYS_PTRACE may be added ([security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html), [task def](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)); `dockerSecurityOptions` "isn't valid" on Fargate ([API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)). Rootless Podman: `cannot clone: Operation not permitted`, open since 2023-02-09 with no AWS reply ([#1957](https://github.com/aws/containers-roadmap/issues/1957)) [R]. Whether Fargate applies a seccomp profile at all is not documented [U] |
| Scale to zero | **pass** [D]: running = compute; suspended = snapshot storage only; terminated = nothing ([launching](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)) | **partial** [I]: per-user cost is zero when stopped, but the host fleet bills per instance-hour (elastic, unlike Hetzner) | **pass** [D]: per second, 1-minute minimum ([pricing](https://aws.amazon.com/fargate/pricing/)) |
| EU region | **pass** [D]: eu-west-1 at launch; eu-central-1 and eu-north-1 from 2026-08-19 ([launch](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms), [expansion](https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-5-additional-regions)) | **pass** [D]: "all commercial regions" ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)) | **pass** [D] |
| Platform reaches unit (HTTP + WS) | **pass, by an alternative route** [D]: each MicroVM has its own public HTTPS endpoint (HTTP/1.1, HTTP/2, WebSockets, gRPC, SSE). A JWE token in `X-aws-proxy-auth` is required on every request ("no unauthenticated access option"). Token is scoped to one MicroVM, a port set, and an expiry. Inside AWS, PrivateLink `com.amazonaws.<region>.lambda-microvm` makes it private ([networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)). From Cloud Run it is a public URL plus token [I] | **pass** [I]: private VPC IPs; from GCP via HA VPN, or a public NLB plus mTLS front proxy | **pass** [I]: awsvpc ENI with private IP; from GCP via VPN or a public LB |
| **H-pg** egress default-deny + allowlist | **pass on paper** [D]: "By default, MicroVMs have public internet access"; a VPC egress connector routes outbound traffic "through your VPC instead", and "outbound traffic is subject to security group rules and network ACLs" ([networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)). SG egress = tcp/5432 to the Postgres /32 (+ tcp/443 to the allowlisted proxy). [U] that a VPC-only connector leaves no internet path, and how DNS and UDP behave (UDP blocked by default [R]) | **pass** [I]: per-VM tap + host nftables, plus SG on the host ENI | **pass** [D]: task ENI security groups ([security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)) |
| Metadata / credentials | **pass** [D]: the execution role is optional; without it the MicroVM "cannot access other AWS services" (no runtime CloudWatch logs either) ([security](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)). With a role, credentials come via IMDS [R], so keep the role off or logs-only | **pass** [I]: block 169.254.169.254 from guests on the host; IMDSv2 hop limit 1 | **pass** [I]: omit `taskRoleArn`; the metadata endpoint 169.254.170.2 then serves no credentials. The nested sandbox has no network anyway |
| Lifecycle API | **pass** [D]: `run-microvm`, `suspend-microvm`, `resume-microvm`, `terminate-microvm`, `list-microvms`, plus `/run` `/suspend` `/resume` `/terminate` hooks ([launching](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)) | **we build it** (Firecracker) or Kubernetes pods (Kata) [I] | **pass** [D]: RunTask/StopTask |

## 3. Deep dive 1: Lambda MicroVMs

### Shape and limits

- **Sizes:** baseline 0.5/1/2/4/8 GB with 2 GB = 1 vCPU (default 2 GB/1 vCPU). Automatic vertical burst to 4x baseline, with burst usage billed only while used. Disk is 8 GB at the 2 GB baseline [D] ([images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)).
- **Architecture:** x86_64 is supported from base image version 3; ARM64 is the default [D]. Early blogs say ARM-only; that is superseded.
- **Image build:** the input is a zip in S3 containing a Dockerfile. `FROM` may be a private ECR image in the same account, so the 1-2 GB gateway image can be the base layer [D]. The image size limit is undocumented [U]; the build host is reported to have ~7.2 GB free [R]. Builds take 2-3 min [R]. Environment variables are fixed per image version [D]. Per-MicroVM data goes in `runHookPayload` (16 KB) [D].
- **Max lifetime:** 8 h total, including suspended time, not adjustable [D]. Every session therefore starts from the image and must hydrate and flush (S4). There is no persistent volume across runs.
- **Throughput per MicroVM** [D] ([quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)):
  - Connections: 150 concurrent, plus 50 per extra vCPU.
  - Requests per second: 40 at 4 vCPU and 160 at 16 vCPU. That suggests about 10 rps per vCPU, but the 1 vCPU value is not stated [U]. Serve shell static assets from the platform or a CDN, not the unit.
  - Endpoint bandwidth: 2 MB/s per vCPU sustained, 10 MB/s per vCPU for 5 s bursts. That is 2 MB/s at our size.

### Snapshot semantics (new engineering risk)

- Builds snapshot the memory and disk of all processes started by `ENTRYPOINT`, including open sockets [D] ([snapshots](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html)).
- AWS says Node `crypto.randomBytes` stays unique after restore. It also says OpenSSL users need AWS's snap-safe OpenSSL [D].
- **Contradiction:** AgentCore's V2 docs say Node's `crypto` (OpenSSL) "can repeat values across instances, even when you call them in your handler" ([AgentCore V2](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-v2-optimize.html)) [D].
- **Reason to doubt the safe reading:** Node bundles its own OpenSSL, so the system snap-safe package does not apply to it [I].
- **Mitigation [I]:** snapshot only a minimal supervisor, and start the gateway in the `/run` hook. Session tokens, UUIDs and Postgres connections are then created after restore. The cost is gateway boot time on every cold start.
- **Measurement [U]:** check for duplicate `crypto.randomUUID()` values across 20 MicroVMs restored from one image.

### Cold start

| Step | Time | Source |
|---|---|---|
| `RunMicrovm` to RUNNING | ~2 s | [R] (Steele, from far outside us-east-1) |
| Then to first HTTP 200 | ~2 s | [R] |
| Suspend | ~1 s | [R] |
| Resume, then to HTTP 200 | ~1 s, then ~1 s | [R] |
| Burst launches | "several hundred" MicroVMs within a minute | [D] ([blog](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)) |

- Image size does not drive cold start the way pulls do, because MicroVMs restore a snapshot instead of pulling. The `/validate` hook records the touched pages for prefetch [D].
- If the gateway boots in `/run` (snapshot mitigation above), add the gateway boot time [U].
- Auto-resume holds the first request while resuming, and returns 502 if the resume fails [D].

### Networking and the Cloud Run path

**Ingress from the platform:**
- The platform (Cloud Run, europe-west1) calls `CreateMicrovmAuthToken` with SigV4 [D]. AWS credentials for that call come from GCP through OIDC web-identity federation [I].
- The platform caches one token per MicroVM; the API is limited to 50 TPS [D].
- Requests go to `https://<id>.lambda-microvm.eu-west-1.on.aws`, with the port in `X-aws-proxy-port`. WebSocket clients pass the token and port as subprotocols [D].
- **Idle timeout and maximum WebSocket duration on this endpoint are undocumented [U].** Also [U]: whether an open WebSocket is cut when its token expires. Shell tokens are reported to cap at 60 minutes ([Giorgi](https://damianogiorgi.it/articles/2026/09/running-ai-agent-sandboxes-on-aws-lambda-microvms/)) [R].
- The client-facing cap stays Cloud Run's 60 min request timeout (first report) [D].

**Egress:**
- **Connector:** a customer VPC egress connector (`aws lambda-core create-network-connector`) with subnets and a security group [D]. ENIs are shared per connector [D]. The ENIs are hidden unless listed with `IncludeManagedResources` [R].
- **Postgres:** the shared Postgres must be reachable from that VPC. That means either RDS or an EC2 Postgres in the same VPC, or a route over VPN to GCP [I].
- **DNS exfiltration:** add Route 53 Resolver DNS Firewall in deny-all mode [I].
- **No NAT needed** [I].

### Quotas at 10,000 users (~140 average, ~420 peak running)

- **Memory:** 400 GB per account per region across RUNNING and SUSPENDED MicroVMs in eu-west-1/eu-central-1 (1,024 GB in four US/Tokyo regions), adjustable. "Burstable up to four times" refers to vertical scaling [D].
  - 420 x 2 GB = 840 GB, so a quota increase is needed [I].
  - Suspended MicroVMs count against the quota, so terminate rather than park them for long [D].
- **API rates (per account and region, all adjustable)** [D]:

  | API | TPS |
  |---|---|
  | RunMicrovm | 5 |
  | ResumeMicrovm | 5 |
  | SuspendMicrovm | 2 |
  | TerminateMicrovm | 10 |
  | GetMicrovm | 100 |
  | CreateMicrovmAuthToken | 50 |

  Session arrivals at peak are about 420 / 1,200 s ≈ 0.35/s [I], well below RunMicrovm's 5. A morning thundering herd of 300 starts takes ≥60 s at 5 TPS, so request 20 TPS.
- **New accounts start with reduced Lambda MicroVM quotas**, which rise automatically [D].

### Price (price list, eu-west-1, per second)

| Item | ARM | x86 |
|---|---|---|
| vCPU-s | $0.0000291572 | $0.0000340538 |
| GB-s | $0.0000038603 | $0.0000045086 |
| Snapshot read | $0.0016403/GB | |
| Snapshot write | $0.0040636/GB | |
| Snapshot storage | $0.00013222/GB-h | |

- Frankfurt ARM is $0.000034996/vCPU-s and $0.000004633/GB-s, which is 20% dearer.
- Baseline is billed for the whole time a MicroVM is RUNNING, whether or not the CPU is busy. Burst above baseline is billed only while used [D] ([pricing](https://aws.amazon.com/lambda/pricing/)).

**Per active hour at 1 vCPU / 2 GB, Ireland ARM:** 0.0000291572 x 3600 = $0.10497, plus 2 x 0.0000038603 x 3600 = $0.02779, **= $0.1328/h**. x86 is $0.1551/h.

**Launch cost:**
- The snapshot size billed per launch is [U]. Assume 3 GB: one launch read costs 3 x $0.00164 = $0.0049.
- A suspend and resume cycle costs a $0.0122 write plus a $0.0049 read = $0.0171.

## 4. ECS on Fargate (reference; likely eliminated)

- **H-userns** (section 2): no privileged mode, no SYS_ADMIN, and no seccomp or `security-opt` override [D]. A non-root `bwrap --unshare-all` will fail if Fargate applies any Docker or containerd-style default profile, which the Podman report suggests it does [I].
  - The Landlock fallback needs kernel ≥6.12; the Fargate kernel version is undocumented [U].
  - Chromium on Fargate is commonly run with `--no-sandbox` ([Flightcontrol](https://www.flightcontrol.dev/docs/tips/deployment/puppeteer)) [R], which is consistent with no userns.
- **Cold start:** AWS publishes no task start figure [U]. SOCI lazy loading (index manifest v2 only) reported ~50% faster starts ([announcement](https://aws.amazon.com/about-aws/whats-new/2023/07/aws-fargate-container-startup-seekable-oci)) [D]. Fargate has no warm pool or snapshot option [I].
- **Quotas** [D] ([ECS quotas](https://docs.aws.amazon.com/general/latest/gr/ecs-service.html), [Fargate throttling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/throttling.html)):

  | Quota | Default | Note |
  |---|---|---|
  | Fargate On-Demand vCPU | 6 | raise to ≥500 |
  | Launch rate | 100 burst, 20/s sustained | |
  | RunTask | 20 calls/s, 10 tasks per call | |
  | Cluster resource modify bucket | 100 burst, 40/s | |
  | Tasks per service | 5,000 | |
  | Services per cluster | 5,000 | |
  | Clusters | 10,000 | |
  | VPC ENIs per region | 5,000 | [U]; one ENI and private IP per task, so size subnets at /20 or larger [I] |

- **Price** (price list): Ireland x86 is $0.04048/vCPU-h and $0.004445/GB-h, so **$0.0494/h at 1 vCPU / 2 GB**. ARM is $0.0395/h. Frankfurt x86 is $0.0568/h. Spot is "up to 70%" off with interruption [D].

## 4a. Lambda functions in depth (Event Functions, SnapStart, Web Adapter, Managed Instances, Web Functions)

**Limits that matter** [D] ([quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)):

| Limit | Value |
|---|---|
| Timeout | 900 s (90 min only for async or event-source invokes on Managed Instances) |
| Memory | up to 10,240 MB |
| Processes and threads | 1,024 |
| `/tmp` | up to 10 GB |
| Container image | up to 10 GB |
| Synchronous payload | 6 MB, or 200 MB streamed |

**Long-lived gateway process:** not possible.
- Execution is invocation-scoped. Between invocations the environment is frozen, and it is reclaimed at Lambda's discretion [D, general Lambda model].
- A gateway that keeps PTYs/zellij, agent child processes and in-memory chat state alive between requests cannot run.
- Child processes are allowed during an invocation (1,024 limit) [D], but they are frozen with the environment.

**Inbound WebSockets:** not to the function.
- The only path is API Gateway WebSocket APIs: each message invokes the function separately. Limits: **2 h connection maximum, 10 min idle timeout, 29 s integration timeout, 32 KB frames, 128 KB messages** ([quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html)) [D].
- Response streaming covers Node managed runtimes, custom runtimes and the [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter). It is response-only, with up to 200 MB per response and 2 MB/s after the first 6 MB.
- Function URLs do not stream inside a VPC ([streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)) [D].
- The Web Adapter wraps an HTTP server into request/response invokes. It does not add inbound WebSockets [I].

**User namespaces:** not available [R]. Podman on Lambda-backed CodeBuild fails with clone EPERM, and AWS says Lambda "doesn't support Docker builds or runs" ([re:Post](https://www.repost.aws/questions/QUZpDgeieDS2GQX-jYwpHzlw/podman-error-on-codebuild-with-lambda-compute)). Chromium on Lambda is run with `--no-sandbox` [R].

**Cold start:**
- Container images load on demand at block level with deduplicated caching ([Brooker et al., ATC'23](https://arxiv.org/abs/2305.13162)) [D, paper]. AWS publishes no figure for 1-2 GB images [U].
- **SnapStart for container images** launched 2026-09-02 ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/07/aws-lambda-snapstart-container/)). It covers Java, Python and .NET base images natively ([blog](https://aws.amazon.com/blogs/compute/get-started-with-aws-lambda-snapstart-for-container-images/)) [D].
- **Node.js** needs the label `com.amazonaws.lambda.feature.snapstart="Allow"` or `/restore/next` hooks [D].
- Measured for Node 22 with a 138 MB image in Tokyo [R] ([Classmethod](https://dev.classmethod.jp/en/articles/lambda-snapstart-container-benchmark/)):
  - Restore p50: 0.4-0.57 s.
  - Client end-to-end p50: 0.57-0.76 s.
  - A 60 s init dropped to 0.56 s.
- Lambda reseeds `/dev/urandom` on restore [D].

**Lambda Managed Instances:** multi-concurrency environments on Lambda-managed EC2 in our account. Capacity providers are the security boundary, and functions run "in containers within instances" ([docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances.html)) [D]. A per-user hardware boundary would need one capacity provider per user [I], so it is not a fit.

**Lambda Web Functions** (launched 2026-10-12 [R]): HTTP servers with at most 2 vCPU / 2 GB and a 30-900 s request timeout ([quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)) [D]. No WebSocket support was found [U]. Environments are shared by a function's traffic, not owned by a user.

**Re-architecture Lambda would force [I]:**
1. Split the gateway into stateless request handlers, with all state in Postgres or S3.
2. Run every WebSocket through API Gateway with a function per message, reconnecting every 2 h and pinging under 10 min.
3. Move agent turns over 15 min into a durable workflow such as Lambda durable functions or Step Functions.
4. Drop the Terminal (PTY/zellij) for free users, or host it elsewhere.
5. Run the bubblewrap sandbox nowhere, because there are no user namespaces.
6. Lose the "one unit per user" model: one function per user is possible, but concurrent requests from one user land in different environments with no shared memory.

That rewrite would affect every gateway surface. Lambda MicroVMs (deep dive 1) is AWS's answer for this workload shape.

## 5. Deep dive 2: microVMs on EC2 nested-virtualization hosts

**Setup:**
- Launch with `--cpu-options NestedVirtualization=enabled` on C7i/C8i/M7i/M8i/R7i/R8i/I7i (non-metal), at no extra cost [D].
- AWS recommends bare metal for "performance sensitive or ... strict latency" workloads [D]. Firecracker on m8i.large is reported working [R] ([Classmethod](https://dev.classmethod.jp/en/articles/ec2-nested-virtualization-support-non-bare-metal/)).

**Two ways to orchestrate:**
1. **Firecracker plus our own scheduler.** Same design as the Hetzner fallback. Lifecycle, images, tap networking and snapshots are ours. We could copy MicroVMs' snapshot-restore model.
2. **EKS managed nodegroup (nested-virt launch template) with Kata.** Lifecycle is pod create/delete, egress is NetworkPolicy plus host SGs, and it ports directly to on-prem Kata [I]. EKS honouring the launch-template nested-virt flag is [R] (#2784).

**Behaviour [I]:**
- Cold start: sub-second to a few seconds on a warm host with the image cached; 60-120 s when a new host must join [U].
- H-userns passes by construction.
- H-pg is enforced on the host, outside the guest.

**Price:**
- m7i.4xlarge (16 vCPU / 64 GiB) in eu-west-1 is $0.8988/h on demand and $0.4632 spot ([ec2.shop](https://ec2.shop), third-party mirror of AWS prices) [R]. The m8i price was not found [U].
- Packing ~28 guests of 2 GiB per host with 2x vCPU oversubscription gives ~$0.032 per guest-hour at full packing [I].

## 6. Cost at 10,000 users x 20 min/day = 100,000 instance-hours/month

**Shared assumptions [I]:**
- 50 MB per active hour flows from AWS to GCP: 5,000 GB at $0.09/GB after 100 GB free = **$441** (price list: $0.09 for the first 10 TB).
- 5 MB of logs per active hour into CloudWatch: 500 GB x $0.57 = **$285**. Both MicroVMs and ECS can send logs elsewhere instead.
- Shared Postgres on RDS sized for ~2,100 peak connections (420 x 5): **~$400-800/mo [U]**.
- No NAT, no public IPv4 per unit, and an interface endpoint only if the control plane moves (price list: $0.011 per AZ-hour).

| Option | Arithmetic | Monthly |
|---|---|---|
| **Lambda MicroVMs, ARM, 2 GB/1 vCPU baseline, Ireland** | 100,000 x $0.1328 = $13,276; launch reads 300,000 x $0.0049 = $1,476; logs $285; transfer $441; RDS ~$600 | **~$16.1k** |
| Same, x86 | 100,000 x $0.1551 = $15,506, plus the same extras | ~$18.3k |
| Same, 1 GB/0.5 vCPU baseline bursting to 4 GB/2 vCPU [I: only if the idle gateway fits in 1 GB] | 100,000 x $0.0664 = $6,638, plus burst usage [U] and extras | ~$9.5k |
| Fargate x86 Ireland (if it passed) | 100,000 x $0.0494 = $4,937; VPN 2 x $0.05 x 730 = $73 (price list) plus GCP side [U]; logs, transfer, RDS | ~$6.3k |
| Fargate ARM | 100,000 x $0.0395 = $3,950, plus extras | ~$5.4k |
| EC2 nested-virt fleet (m7i.4xlarge) | Autoscaled average ≈ 139 x 1.25 / 28 + 1 spare ≈ 7.2 hosts x 730 x $0.8988 = $4,724. A fixed peak-sized fleet of 20 hosts = $13,122. EKS $73 [U]; EBS [U] | ~$6k to ~$14.5k, plus engineering |
| AgentCore Runtime (eliminated; US rates, EU not shown) | 25% CPU: 100,000 x (0.25 x 0.0895 + 2 x 0.00945) = $4,128; 100% CPU: $10,840 | |
| Cloud Run gen2 (first report) | | $7.9k |

**Sensitivity:**
- The spec D3 idle tail of 10 minutes multiplies pay-per-use figures by 1.5. On MicroVMs, suspending after 2 minutes and resuming costs $0.0171 per cycle, against $0.022 for 10 running minutes. That only wins if the user returns [I].
- 300,000 launch reads assumes one launch per user-day. Two suspend and resume cycles per user-day would add ~$10k/mo at a 3 GB snapshot, so prefer terminate plus rehydrate [I].

**Credit runway ($100k), at full 10k-user load:**

| Option | Runway |
|---|---|
| MicroVMs, 2 GB | ~6.2 months (~4.5 with the 1.5x tail) |
| MicroVMs, 1 GB | ~10.5 months |
| Fargate | ~16 months |
| EC2 fleet | ~7-16 months |

**Credit coverage:**
- Excluded from promotional credits [D] ([terms](https://aws.amazon.com/awscredits/), updated 2026-09-24): Marketplace, Enterprise-tier Support, Professional Services, domain registration, and upfront fees for Savings Plans and RIs.
- Credits apply "only to the specific Services designated by your AWS contracting entity" [D]. Compute, data transfer and CloudWatch are normally covered [I].
- Check with the account team [U]: whether the new Lambda MicroVMs SKUs are on the designated list, the credits' expiry date, and whether the GCP-side egress charge (billed by Google) is outside the credits, which it is [I].

## 7. Moving the control plane and shared Postgres to AWS

**What moves [I]:**
- The platform service: Cloud Run to ECS on Fargate. The platform is trusted code and does not need userns.
- Platform Postgres: to RDS or Aurora PostgreSQL. Where it lives today is [U].
- The per-owner shared Postgres from S5: to RDS in the MicroVM VPC.
- DNS for `app.matrix-os.com`, plus secrets (Clerk, Stripe, provider keys) into Secrets Manager.
- R2, Clerk and the Hetzner paid VPS fleet are unaffected.

**What it buys:**
- Ingress over PrivateLink (`lambda-microvm` interface endpoint) [D] instead of public URL plus token.
- No cross-cloud transfer cost ($441/mo in the estimate).
- No VPN between clouds, and SG-to-SG rules to Postgres.
- Lower latency between Cloud Run europe-west1 and eu-west-1 [U].

**What it costs:**
- A platform migration with downtime planning.
- New IaC.
- A second set of CI deploy credentials.
- The paid tier's existing Hetzner routing keeps working from either cloud [I].

**Recommendation [I]:** run the S1 probe from Cloud Run first. Move only the shared Postgres next to the units, because S5's direct TCP with 5 connections per owner is latency-sensitive. Decide on the control plane after the free tier proves out.

## 7a. Wake time, stopped to interactive (primary soft criterion, target under 5 s)

"Interactive" here means the gateway answers `/healthz` and accepts the shell WebSocket. Hydration of the owner's home (S4) is extra unless it is lazy [I].

**Arrival assumptions for pool sizing [I]:**
- 10,000 sessions a day is 0.116 wakes/s on average. The 420-concurrent peak is 0.35/s.
- Peak-minute bursts are assumed 3x, about 1 wake/s.
- Pool size ≈ burst rate x replenish time + margin.

**Pre-booted generic units bound at claim time [I]:** every pool member boots the gateway with no owner identity. On claim, the platform sends one authenticated bind request carrying the owner's Postgres credentials, the hydrate manifest and the session token. The member is never returned to the pool, so it is single-use and nothing crosses owners.

| Option | Realistic stopped to listening | Ways to cut it | Idle capacity cost for under 5 s |
|---|---|---|---|
| **Lambda MicroVMs** | **Run from image:** ~2 s to RUNNING, plus ~2 s to HTTP 200 [R] ([Steele](https://awsteele.com/blog/2026/06/23/some-notes-on-lambda-microvms.html)). Add gateway boot if the gateway starts in `/run` to avoid snapshot randomness reuse [U]. **Resume an owner's own suspended MicroVM:** ~1 s, plus ~1 s to HTTP 200 [R]. Auto-resume holds the first request [D] | (a) Suspend instead of terminate when the owner is likely to return within the 8 h lifetime. (b) Keep a **pool of suspended generic MicroVMs**: each runs, boots the gateway after restore (unique randomness), then suspends. A claim auto-resumes it (~2 s [R]) and binds the owner (<1 s [I]). (c) `/validate` hook page prefetch [D] | (a) Snapshot storage at $0.000132/GB-h plus a $0.0122 write per suspend (3 GB assumed). (b) A pool of 30-50 (≈1/s x ~15 s replenish + margin). Storage ≈ 50 x 3 GB x 730 h x $0.000132 = **$15/mo**. Recycling every ≤4 h because of the 8 h cap ≈ 9,000 cycles x ~$0.018 ≈ **$160/mo**. Uses 100 GB of the memory quota. **Total ~$175/mo** |
| ECS on Fargate | 30-45 s or more typical (AWS re:Post answer [R]); 55 s for a 2.7 GB image ([2026 blog](https://hn.jakechampion.name/reader/https://drorspei.com/2026/01/23/my-fargate-startup-is-slow-an-investigation-into-docker-layer-optimization)) [R]; scheduling 11-39 s ([Cribl](https://cribl.io/blog/analyzing-aws-fargate)) [R]. Image pull dominates ([CON307](https://d1.awsstatic.com/events/Summits/reinvent2023/CON307_Reducing-AWS-Fargate-startup-times-by-lazy-loading-container-images.pdf)) [D]. Estimate for 1-2 GB: **30-60 s** [I] | SOCI v2 (~50% faster [D]); zstd layers (up to 27% [D]); smaller image. Still 15-30 s [I]. **Warm pool of running generic tasks** gives a claim-plus-bind of ~1-3 s [I] | Pool ≈ 1/s x 60 s + margin: ~80 at peak, ~20 off-peak, ~40 on average. 40 x 730 x $0.0494 = **~$1.4k/mo**. Moot unless the userns probe passes |
| ECS on EC2 / EC2 warm pools | Task onto a running host with a cached image: container start 0.5-0.7 s [R] plus agent placement [U], **a few seconds** [I]. A one-task-per-instance VM boundary means a new instance per wake. A hibernated instance resumes in a time that "is dependent on the memory size ... and the throughput of the root EBS volume" ([AWS](https://aws.amazon.com/blogs/aws/new-hibernate-your-ec2-instances/)) [D], with no published seconds [U]. **Tens of seconds** [I] | ASG warm pool in the Stopped or Hibernated state: you pay EBS only ([warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html)) [D]. Not under 5 s [I] | n/a: shared-kernel placement fails isolation, and one-instance-per-user misses 5 s |
| **Self-run Firecracker on EC2** | VMM snapshot restore in ~4-10 ms ([Brooker](https://brooker.co.za/blog/2022/11/29/snapstart/)) [R] or ~28 ms on a desktop ([dev.to](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k)) [R]; cold guest boot ~1.1 s [R]. With a generic booted-gateway snapshot stored locally on each host plus a bind call: **under 1 s** [I]. Nested-virt overhead is [U]; AWS recommends metal for latency-sensitive work [D] | Restore from a host-local snapshot (UFFD lazy memory). Keep host headroom so a wake never waits for an EC2 launch (60-120 s [U]) | Headroom ≈ 0.35-1/s x 120 s + margin = 60-150 slots x $0.032 per slot-hour [I] = **$1.4k-3.5k/mo**, on top of the fleet in section 6 |
| EC2 metal hosts (same, no nested overhead) | Same as above | Same | Per-GiB price equals the virtual sizes in the same family. m7i.metal-24xl is $5.39/h for 96 vCPU / 384 GiB ($0.0140/GiB-h), the same as m7i.4xlarge at $0.8988/64 GiB. c7i.metal-24xl is $4.60/h; m8g.metal-24xl (Graviton 4) is $4.80/h (eu-west-1, [ec2.shop](https://ec2.shop)) [R]. Granularity is coarse: one host holds ~170 guests at 2 GiB, so peak needs 3 hosts plus 1 spare ≈ $15.7k/mo fixed [I] |
| Lambda Event Functions + SnapStart | Restore p50 0.4-0.57 s; client end-to-end p50 0.57-0.76 s (Node 22, 138 MB image) [R] | Already snapshot-based | n/a: architecture fails (section 4a) |
| AgentCore Runtime V2 | Snapshot restore "consistent regardless of concurrency or image size" ([docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)) [D]; no figure [U] | n/a | n/a: eliminated |

**Closest to under 5 s:**

1. **Lambda MicroVMs.** Resuming an owner's own suspended MicroVM, or claiming a suspended generic pool member, takes about 2-3 s by third-party timings. The pool is the only AWS route that costs almost nothing idle, about $175/mo. A cold run from the image (~4 s, plus gateway boot if it starts after restore) is borderline.
2. **Self-run Firecracker on EC2** (nested-virt or metal). Raw restore is the fastest, under 1 s [I], but costs $1.4k-3.5k/mo in idle headroom plus the build and operations effort.
3. **Fargate with a running warm pool.** About 1-3 s at ~$1.4k/mo idle, but it likely fails the userns criterion.

For comparison with the first report [I]:
- Cloud Run gen2's cold start is [U]. A pool of pre-deployed generic services kept warm with min-instances would cost about 40 x 730 x $0.0792 ≈ $2.3k/mo.
- Cloudflare Containers documents 1-3 s, with a reported tail past 45 s.

## 8. Ranking against the first report

**With wake time under 5 s as the primary soft criterion, the order changes at the top:**

1. **Lambda MicroVMs** is the only candidate in either report that documents a snapshot-based suspend and resume API, so under 5 s needs no always-on idle capacity (~$175/mo for a suspended pool). It is also the only AWS option that passes every hard criterion on paper.
2. **Cloud Run gen2** is first on cost per hour and on wiring. It costs $0.079/h, has private ingress, VPC firewall egress and TCP to Postgres natively, and the platform is already there. H-userns is also [U] there; gen2 claims "all system calls, namespaces", which makes it plausible.
   - Under 5 s on Cloud Run likely needs a min-instances warm pool (~$2.3k/mo [I]), and its gen2 cold start is unmeasured.
   - If the measured cold starts are close, Cloud Run's lower hourly price outweighs the pool cost at 10k users ($7.9k + $2.3k < $16k). If credits pay for AWS, MicroVMs wins until the credits run out.

   Lambda MicroVMs compared with Cloud Run:
   - **Stronger than Cloud Run on:** documented capability control, and suspend/resume.
   - **Weaker than Cloud Run on:** price (1.7x Cloud Run per hour), the 8 h lifetime cap, unknown WebSocket limits, snapshot randomness risk, low per-unit rps and bandwidth, and a public ingress URL from GCP.
   - **Credits:** it is the right AWS choice if credits are to fund the free tier.
3. **Cloudflare Containers** stays below both, because H-pg fails under default-deny (only HTTP(S) leaves).
4. **EC2 nested-virt or metal microVMs** is the self-built fallback. It has the fastest raw wake (Firecracker restore under 1 s [I]) but needs $1.4k-3.5k/mo of idle headroom. It is the most portable through EKS+Kata, but we would build and operate it.
5. **Fargate** is eliminated unless the probe shows userns works. Its cold wake is 30-60 s, so under 5 s needs a ~$1.4k/mo running pool.
6. **Lambda Event Functions** fail as a unit host: sub-second SnapStart wake, but no long-lived process, no inbound WebSocket and no userns (section 4a).

**Portability:**
- MicroVMs: the API, zip-plus-Dockerfile build, hooks and JWE ingress are proprietary. The unit is an ordinary OCI image behind the substrate interface. The snapshot model maps to Firecracker on Hetzner or on-prem [I].
- Fargate: ports to Kubernetes trivially [I].
- EKS+Kata: ports directly [I].

## 9. Measurement plan (run only after the account owner approves; nothing here has been run)

Use a throwaway AWS account or sub-account in eu-west-1 so that teardown is complete. Reuse the S1 probe image from the first report: `/healthz`, `/probe/egress`, `/probe/isolation`. Add these checks:

- `id`; `cat /proc/sys/user/max_user_namespaces`; `grep -E 'Seccomp|CapBnd|CapEff' /proc/self/status`
- As uid 61184: `unshare -Urn true`, then `bwrap --unshare-all --ro-bind / / true`
- `uname -r`, plus a Landlock ABI check
- `node -e 'console.log(crypto.randomUUID())'`, run in `/run`
- `curl -m3 http://169.254.169.254/latest/meta-data/` (IMDS)
- `dig @169.254.169.253 example.com`

### A. Lambda MicroVMs (primary)

```bash
R=eu-west-1; A=<account-id>; B=s1-spike-$RANDOM
aws s3 mb s3://$B --region $R
# Dockerfile: FROM public.ecr.aws/lambda/microvms:al2023-minimal (and a second variant FROM <our ECR gateway image>);
# install bubblewrap util-linux nodejs; USER 61184 for the probe server; hooks on the hook port.
zip -r probe.zip Dockerfile app/ && aws s3 cp probe.zip s3://$B/probe.zip
aws iam create-role --role-name s1-build --assume-role-policy-document file://trust-lambda.json   # lambda.amazonaws.com, sts:AssumeRole + sts:TagSession
aws iam put-role-policy --role-name s1-build --policy-name s1 --policy-document file://build-policy.json  # s3:GetObject on $B, logs:*
for caps in default all; do
  aws lambda-microvms create-microvm-image --region $R --name s1-probe-$caps \
    --code-artifact uri=s3://$B/probe.zip \
    --base-image-arn arn:aws:lambda:$R:aws:microvm-image:al2023-1 \
    --build-role-arn arn:aws:iam::$A:role/s1-build --cpu-configurations architecture=X86_64 \
    $( [ $caps = all ] && echo "--additional-os-capabilities [\"ALL\"]" )
done
# Egress VPC: no IGW, no NAT. SG egress only tcp/5432 to the test Postgres.
V=$(aws ec2 create-vpc --cidr-block 10.9.0.0/16 --query Vpc.VpcId --output text)
S=$(aws ec2 create-subnet --vpc-id $V --cidr-block 10.9.1.0/24 --query Subnet.SubnetId --output text)
G=$(aws ec2 create-security-group --vpc-id $V --group-name s1-unit --description s1 --query GroupId --output text)
aws ec2 revoke-security-group-egress --group-id $G --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'
aws rds create-db-instance --db-instance-identifier s1-pg --engine postgres --db-instance-class db.t4g.micro \
  --allocated-storage 20 --master-username s1 --master-user-password "$PGPW" --no-publicly-accessible \
  --db-subnet-group-name <subnet-group-in-V> --vpc-security-group-ids <pg-sg>
aws ec2 authorize-security-group-egress --group-id $G --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=<pg-ip>/32}]"
aws lambda-core create-network-connector --name s1-egress --operator-role arn:aws:iam::$A:role/s1-nc-operator \
  --configuration "{\"VpcEgressConfiguration\":{\"SubnetIds\":[\"$S\"],\"SecurityGroupIds\":[\"$G\"],\"NetworkProtocol\":\"IPv4\",\"AssociatedComputeResourceTypes\":[\"MicroVm\"]}}"
# Units: one with only the VPC connector, one with INTERNET_EGRESS (control). No execution role on either.
aws lambda-microvms run-microvm --image-identifier <img-arn> \
  --ingress-network-connectors arn:aws:lambda:$R:aws:network-connector:aws-network-connector:HTTP_INGRESS \
  --egress-network-connectors <nc-arn> --maximum-duration-in-seconds 14400 \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":120,"suspendedDurationSeconds":900}'
T=$(aws lambda-microvms create-microvm-auth-token --microvm-identifier $ID --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]' --query 'authToken."X-aws-proxy-auth"' --output text)
curl -s -H "X-aws-proxy-auth: $T" https://$EP/probe/isolation; curl -s -H "X-aws-proxy-auth: $T" https://$EP/probe/egress
```

| Check | What to record | Pass condition |
|---|---|---|
| H-userns | default capabilities vs `ALL` | `bwrap --unshare-all` succeeds as non-root under one of them |
| Egress | 5432 open; example.com, UDP 53 and 8.8.8.8 blocked; DNS answers; IMDS | the VPC-only unit has no internet path |
| Cold start | 20 x `run-microvm` to first 200 from a europe-west1 Cloud Run job; 20 x suspend then auto-resume | gateway boot both at build time and in `/run` |
| Wake (primary soft criterion) | (1) Cold run from the image, gateway booted in `/run`. (2) Owner's own MicroVM after 5 min and after 2 h suspended. (3) Claim of a suspended generic pool member: auto-resume, then a bind request carrying test Postgres credentials, then the first shell WebSocket frame | p50/p95 over 20 samples, timed from a europe-west1 caller. Pass: p95 under 5 s for (2) and (3) |
| Snapshot uniqueness | `randomUUID()` and the first `crypto.randomBytes(16)` from 20 MicroVMs off one image | no duplicates |
| Cross-tenant | unit A's token against unit B's endpoint | 403 |
| WebSocket | hold 4 h with a 30 min token; record cuts and idle cut-off with and without 30 s pings | |
| Throughput | `hey -z 60s -c 50` against `/healthz` | rps and 429 point at 1 vCPU; connections up to 150 |
| Billing | Cost Explorer next day | snapshot GB billed per launch, which sets the $0.0049 assumption |

**Teardown:**

```bash
aws lambda-microvms terminate-microvm --microvm-identifier <id>          # each
aws lambda-microvms delete-microvm-image --image-identifier <img-arn>    # each
aws lambda-core delete-network-connector --network-connector-identifier <nc-arn>
aws rds delete-db-instance --db-instance-identifier s1-pg --skip-final-snapshot
aws ec2 delete-security-group --group-id $G; aws ec2 delete-subnet --subnet-id $S; aws ec2 delete-vpc --vpc-id $V
aws s3 rb s3://$B --force; aws iam delete-role-policy --role-name s1-build --policy-name s1; aws iam delete-role --role-name s1-build
```

**Expected cost: under $6.** About 6 MicroVM-hours x $0.155 = $0.93, plus about 60 launch and resume reads ≈ $0.30, plus about 60 suspend writes for the wake tests ≈ $0.75, plus RDS db.t4g.micro for ~6 h ≈ $0.15 [U], plus S3 and logs in cents.

### B. Fargate userns check (decisive, ~15 minutes)

Task definition: `requiresCompatibilities=FARGATE`, `cpu=1024`, `memory=2048`, `user=61184`, no `taskRoleArn`. The probe prints `/probe/isolation` to the awslogs driver at start. The VPC needs a `logs` endpoint and ECR endpoints, or a public subnet with a public IP for this test only.

```bash
aws ecs create-cluster --cluster-name s1
aws ecs register-task-definition --cli-input-json file://s1-fargate-task.json
aws ecs run-task --cluster s1 --launch-type FARGATE --task-definition s1-probe --count 1 \
  --network-configuration 'awsvpcConfiguration={subnets=[<subnet>],securityGroups=[<sg>],assignPublicIp=ENABLED}'
aws logs tail /ecs/s1-probe --since 15m
aws ecs delete-cluster --cluster s1   # after the task stops; deregister and delete the task definition
```

- Also time 10 RunTask to RUNNING samples, with and without a SOCI v2 index.
- **Expected cost: under $1.**

### C. Optional: nested-virt Firecracker host

```bash
aws ec2 run-instances --instance-type m8i.large --image-id <al2023-ami> --cpu-options NestedVirtualization=enabled \
  --subnet-id <subnet> --security-group-ids <sg> --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1
# on host: ls /dev/kvm; install firecracker; boot a 6.12 guest; time 20 boots; run bwrap in guest; nftables egress allowlist per tap
# wake: boot guest with the gateway, PUT /snapshot/create (Full); then 20 x restore from host-local file (file and uffd backends);
# record restore-to-/healthz on nested virt; repeat once on a metal host (m7i.metal-24xl ~$5.39/h, 30 min ≈ $2.70) to measure nested overhead
aws ec2 terminate-instances --instance-ids <id>
```

- **Expected cost: under $4**: 2 h of m8i.large at about $0.14/h [R], plus 30 min of m7i.metal-24xl.

**Total expected spend: under $15** (the metal comparison in C adds ~$3). Drive A and B from a europe-west1 caller, so latency numbers match the real platform path.
