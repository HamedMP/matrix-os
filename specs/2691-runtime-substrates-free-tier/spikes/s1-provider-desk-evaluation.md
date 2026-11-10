# S1 provider desk evaluation (research only, nothing deployed)

All sources were read on 2026-11-10. [D] means the documentation states it. [I] means inferred. [U] means unverified, and each [U] becomes a measurement item.

## 1. Hard-criteria matrix

| Criterion | Cloudflare Containers | Fly Machines | Cloud Run (gen2) | Hetzner microVMs |
|---|---|---|---|---|
| Isolation | **pass** [D]: one Firecracker microVM per instance, own kernel ([arch](https://developers.cloudflare.com/containers/platform-details/architecture/)) | **pass** [D]: Firecracker VM per Machine ([blog](https://fly.io/blog/sandboxing-and-workload-isolation/)) | **pass** [D]: "hardware-backed layer equivalent to individual VMs", VMM boundary per instance; gen2 is a microVM ([security](https://docs.cloud.google.com/run/docs/securing/security), [envs](https://docs.cloud.google.com/run/docs/about-execution-environments)) | **pass** [I]: KVM Firecracker. Needs dedicated (Robot) hosts. Hetzner Cloud exposes no /dev/kvm (third-party reports only, [U]) ([ref](https://mvm-deployment-docs.pages.dev/providers/hetzner/)) |
| Scale to zero | **pass** [D]: billed per 10 ms while running; sleeps after inactivity ([pricing](https://developers.cloudflare.com/containers/pricing/)) | **pass** [D]: stopped Machine pays rootfs only, $0.15/GB-mo ([pricing](https://docs.fly.io/about/pricing)) | **pass** [D]: min-instances 0; manual instance count 0 disables the service ([manual scaling](https://docs.cloud.google.com/run/docs/configuring/services/manual-scaling)) | **partial** [I]: an idle user costs nothing extra, but the host fleet is a fixed monthly cost |
| EU region | **pass** [D]: `constraints.jurisdiction = "eu"` (EEUR, WEUR) since Apr 2026. Docs say "restrict" but not whether hard or a hint [U] ([placement](https://developers.cloudflare.com/containers/platform-details/placement/)) | **pass** [D]: ams, arn, cdg, fra ([regions](https://docs.fly.io/reference/regions)) | **pass** [D]: europe-west1/4 and others ([pricing](https://cloud.google.com/run/pricing)) | **pass**: Falkenstein, Nuremberg, Helsinki ([AX](https://www.hetzner.com/dedicated-rootserver/matrix-ax/)) |
| Platform reaches unit (HTTP + WS) | **pass, by an alternative route** [D]: no private IP. Path is platform -> our Worker on a custom domain (mTLS or secret header) -> Durable Object (eu) -> `ctx.container` port `fetch()`. WebSockets only via `fetch()`. WS lifetime [U] | **pass, by an alternative route** [D/I]: 6PN private network only through a WireGuard peer, which Cloud Run cannot easily host. Use fly-proxy public hostname + `fly-force-instance-id` header + platform token ([6PN](https://fly.io/docs/networking/private-networking)) | **pass** [D]: `ingress=internal` + IAM invoker; platform calls through Direct VPC egress in the same project. WS capped by the 60 min request timeout ([ingress](https://docs.cloud.google.com/run/docs/securing/ingress), [WS](https://docs.cloud.google.com/run/docs/triggering/websockets)) | **pass** [I]: HA VPN from the platform VPC to hosts, or mTLS front proxy (today's paid-VPS pattern) |
| Egress default-deny + allowlist | **pass, HTTP(S) only** [D]: `enableInternet:false` plus per-host intercepts/outbound Workers; DNS answers only intercepted hosts. **Non-HTTP TCP (Postgres 5432) is denied** ([outbound](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)) | **FAIL** [D]: network policies allow by port/protocol only, no destination rules, and do not apply to fly-proxy traffic. "Allow tcp/443" means any host on 443 ([policies](https://docs.fly.io/machines/guides-examples/network-policies)) | **pass** [D]: `--vpc-egress=all-traffic` + VPC egress firewall by tag/SA ([Direct VPC](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)). Metadata server still serves an SA token [D]. Metadata-DNS exfiltration [U] | **pass** [I]: host nftables per tap device, outside the guest |
| Lifecycle API | **pass** [D/I]: create/start/stop/destroy are DO methods we expose through our own control Worker; list is REST `GET /accounts/{id}/containers/applications/{app}/instances-v2` ([API](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list)) | **pass** [D]: Machines REST API | **pass** [D]: Admin API v2 services create/get/list/delete; start/stop by setting manual instance count 1/0 | **pass, but we build it** [I] |
| Nested sandbox | **pass** [D]: Docker-in-Docker supported with root dockerd and `--iptables=false --ip6tables=false --ip-forward=false`; inner containers need `--network=host` ([FAQ](https://developers.cloudflare.com/containers/faq/)). bwrap/unprivileged userns [U] | likely [I]: root in a full VM, Docker reported working by community; no official statement [U] | **pass** [D]: gen2 supports "all system calls, namespaces, and cgroups"; plus **Cloud Run sandboxes** (public preview since Jul 2026, `--sandbox-launcher`): egress denied by default, no env vars, no metadata server ([blog](https://cloud.google.com/blog/topics/developers-practitioners/google-cloud-run-sandboxes-are-in-public-preview)). bwrap/userns [U] | **pass** [I]: we choose the guest kernel |

Not added as a fifth candidate: Modal (isolation is gVisor rather than a hardware VM [I]) and Koyeb (no egress policy documentation found [U]). Nothing found is clearly stronger than the four.

## 2. Soft criteria

| | Cloudflare | Cloud Run (europe-west1) | Fly (fra) | Hetzner |
|---|---|---|---|---|
| Cold start, 1-2 GB image | Docs: "often 1-3 s" [D]. Third-party: hello-world median 1.7 s with a tail past 45 s; larger image ~10 s ([Alchemy](https://alchemy.run/blog/2026-07-01-microvm-cold-starts/)) [U] | gen2 "longer cold start times than first generation for some services"; no figure [U] | start of an existing Machine "well under a second"; create "low double digit seconds" [D] ([overview](https://docs.fly.io/machines/overview)) | [U]; Firecracker boot typically sub-second |
| $/active hour, 1 vCPU / 2 GiB | CPU $0.000020/vCPU-s (billed on active use only), mem $0.0000025/GiB-s, disk $0.00000007/GB-s [D]. Smallest 1-vCPU custom shape is 3 GiB (min 3 GiB/vCPU) ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)). At 1 vCPU/3 GiB/8 GB: **$0.101/h at 100% CPU, $0.047/h at 25%** | Instance-based: $0.000018/vCPU-s, $0.000002/GiB-s -> **$0.0792/h**. Request-based: $0.000024 / $0.0000025 + $0.40/M req -> $0.1044/h. Read from the page's region data [D] | perf-1x 2 GB $33/mo in iad [D]; fra assumed 1.154x (ratio of shared-1x 1 GB, $7.73/$6.70) [I] -> $0.053/h | fixed fleet |
| Persistent volume | none; snapshots (beta, max 20 GB, 30-day retention) or R2 FUSE [D] | default in-memory FS counts against RAM [D]; ephemeral disk is a SKU on the pricing page ($0.08/GiB-mo) [U]; GCS FUSE / NFS | Volumes $0.15/GB-mo [D] | local NVMe |
| Image size | equal to instance disk; 50 GB image storage per account [D] | "no direct limit on container image size" [D] | [U] | n/a |
| Max lifetime | not stated; SIGTERM then up to 15 min grace before SIGKILL [D] | services unbounded; jobs 168 h [D] | [U] | n/a |
| Quotas (defaults, raisable) | 1,500 vCPU / 6 TiB memory / 30 TB disk concurrent per account [D] | **100 instances per project+region**, 1,000 services, 4,000 serving revisions per project+region [D] ([quotas](https://docs.cloud.google.com/run/quotas)) | machines per org [U] | own capacity |
| WebSocket limit | not stated; proxying through a DO bills DO duration while connected; DO redeploys drop sockets [I] | **60 min** (request timeout), then client must reconnect [D] | [U] | none |
| Lifecycle API rate | Cloudflare REST global limit [U]; start/stop run inside our Worker | Admin API 180 writes / 3,000 reads per minute per region [D] | 1 req/s per action, burst 3; Get 5 req/s [D] ([API](https://docs.fly.io/machines/api/working-with-machines-api)) | own |

### 10k free users x 20 min/day

10,000 x 20 min x 30 days = **100,000 instance-hours/month**; average concurrency 10,000 x 20 / 1,440 = ~139.

- **Cloud Run, instance-based:** 100,000 x $0.0792 = **$7,920/mo**. Free tier (240k vCPU-s + 450k GiB-s) takes off ~$5. Request-based would be 100,000 x $0.1044 = $10,440.
- **Cloudflare, 1 vCPU / 3 GiB / 8 GB:**
  - Compute: 100,000 x $0.047 = **$4,700** at 25% average CPU; 100,000 x $0.101 = $10,100 at 100%.
  - DO duration (128 MB billed while WS held, no hibernation): 0.125 GB x 360M s = 45M GB-s, minus 400k included = 44.6M x $12.50/M = **~$558**.
  - Plus $5 Workers Paid plan; included container allowances (375 vCPU-min, 25 GiB-h) are negligible. Egress $0.025/GB after 1 TB.
  - Total ~$5.3k (25% CPU) to ~$10.7k (100% CPU).
- **Fly (eliminated, reference only):** 100,000 x $0.053 = $5,300, plus stopped rootfs 10k x ~1.5 GB x $0.15 = $2,250 -> ~$7,550.
- **Hetzner:** assumed peak = 3x average = ~420 instances x 2 GiB = ~840 GiB. 8 + 1 spare AX102 (16c/32t, 128 GB) at EUR 159 = **EUR 1,431/mo** fixed, plus EUR 1,161 one-time setup and ops cost [I].
- **Sensitivity:** a 10 min idle tail before stop (spec D3) multiplies every pay-per-use figure by 1.5.

## 3. Eliminated

- **Fly Machines**: fails *enforceable egress allowlist*. Network policies filter by port/protocol only, so destination allowlisting is impossible from the substrate; in-VM filtering does not count under our trust model.
- **Hetzner microVMs**: not eliminated on a hard criterion, but kept as fallback rather than shortlisted. It fails the intent of "no idle compute charge" (fixed fleet), and we would build the lifecycle API, scheduler, and images ourselves.

## 4. Ranked shortlist

1. **Cloud Run gen2, one service per free user, europe-west1.**
   - Strengths: platform already runs there; private ingress, VPC firewall egress, and TCP to Postgres are native; provider-supported nested sandbox exists.
   - Main risk: **scale and wiring at 10k.** Default quotas are 100 instances and 1,000 services per project+region, so we need multiple projects or quota grants.
   - Also: WebSockets cut at 60 min; gen2 cold start for a 1-2 GB image unknown; metadata server hands untrusted code an SA token (runtime SA must have zero roles); Cloud Run sandboxes still preview; default filesystem is RAM-backed.
2. **Cloudflare Containers, `jurisdiction=eu`.**
   - Strengths: likely cheapest at low CPU utilisation; strong per-host default-deny egress; DinD supported.
   - Main risk: **Postgres unreachable under default-deny** because only HTTP(S) can leave. Needs a pg-over-WebSocket bridge through an outbound Worker (Workers TCP `connect()` or Hyperdrive), which also affects S5's advisory locks.
   - Also: wide cold-start tail; WebSocket path goes through a Durable Object and drops on deploys; smallest 1-vCPU shape is 3 GiB; EU jurisdiction enforcement wording unclear.

## 5. Measurement plan (run only after the account owner approves)

**Probe image.** The real gateway base image (1-2 GB) plus a tiny Node server with:
- `/healthz`, logging process-start and listen timestamps.
- `/probe/egress`, which tries: https://example.com (expect deny); the allowlisted proxy (expect allow); raw TCP to the test Postgres on 5432; UDP 8.8.8.8:53; DNS lookup of a random name; the metadata URL.
- `/probe/isolation`, which records:
  - `uname -a` and `grep hypervisor /proc/cpuinfo`
  - `grep Seccomp /proc/self/status` and `capsh --print`
  - `cat /proc/sys/user/max_user_namespaces` and `unshare -Urn true`
  - `bwrap --unshare-all --ro-bind / / true`
  - nested container run, or `sandbox do -- curl https://example.com` (expect failure) and `sandbox do -- env` (expect no secrets).

### Cloud Run (throwaway project so teardown is complete)

```bash
P=s1-spike-$RANDOM; R=europe-west1
gcloud projects create $P && gcloud config set project $P   # link billing
gcloud services enable run.googleapis.com artifactregistry.googleapis.com compute.googleapis.com
gcloud artifacts repositories create s1 --repository-format=docker --location=$R
docker build -t $R-docker.pkg.dev/$P/s1/probe:1 . && docker push $R-docker.pkg.dev/$P/s1/probe:1
gcloud compute networks create s1 --subnet-mode=custom
gcloud compute networks subnets create s1 --network=s1 --region=$R --range=10.8.0.0/24 --enable-private-ip-google-access
gcloud compute firewall-rules create deny-egress --network=s1 --direction=EGRESS --action=DENY --rules=all --destination-ranges=0.0.0.0/0 --priority=65000 --target-tags=free
gcloud compute firewall-rules create allow-proxy --network=s1 --direction=EGRESS --action=ALLOW --rules=tcp:443,tcp:5432 --destination-ranges=<proxy-ip>/32,<pg-ip>/32 --priority=1000 --target-tags=free
gcloud iam service-accounts create s1-rt          # no roles
for s in a b; do gcloud beta run deploy probe-$s --image=$R-docker.pkg.dev/$P/s1/probe:1 --region=$R \
  --execution-environment=gen2 --cpu=1 --memory=2Gi --no-cpu-throttling --max-instances=1 --timeout=3600 \
  --ingress=internal --no-allow-unauthenticated --service-account=s1-rt@$P.iam.gserviceaccount.com \
  --network=s1 --subnet=s1 --vpc-egress=all-traffic --network-tags=free --sandbox-launcher; done
```

- Run all probes from a caller Cloud Run job on the same subnet.
- Cold start, 20 samples: set manual instance count 0 then 1 (check exact `--scaling` flag against the manual-scaling doc), poll `/healthz` with an ID token, record time. Second set of 20 with autoscaling after a full scale-to-zero.
- Cross-tenant: probe-a uses its own metadata token to call probe-b's URL; expect 403.
- WebSocket: hold 4 h, record cuts at 60 min.
- Teardown: `gcloud projects delete $P`.
- Expected cost: under $5 (about 3 instance-hours plus Artifact Registry storage).

### Cloudflare Containers

Spike Worker: one DO class with `[containers.constraints] jurisdiction="eu"`, instance type 1 vCPU / 3 GiB / 8 GB, `enableInternet:false`, outbound intercepts for the proxy and platform hosts only, and an `X-Spike-Secret` check on every route.

```bash
npx wrangler@latest deploy
for i in $(seq 1 20); do curl -s -w '%{time_total}\n' -H "X-Spike-Secret: $S" https://s1.<test-domain>/cold/$(uuidgen)/healthz; done  # fresh DO name = guaranteed cold
curl -H "X-Spike-Secret: $S" https://s1.<test-domain>/w/x/probe/egress     # expect 5432 denied
curl -H "X-Spike-Secret: $S" https://s1.<test-domain>/w/x/probe/isolation  # plus dockerd --iptables=false --ip-forward=false; docker run --network=host alpine true
npx wrangler containers instances <APP_ID> --json   # list API + region of each sample
```

- Placement: outbound handler records `request.cf.colo` per sample to confirm EU placement.
- WebSocket: hold 4 h, run `wrangler deploy` mid-test, record disconnects.
- Optional: Worker `connect()` to Postgres to price the S5 bridge workaround.
- Teardown: `npx wrangler delete`, `npx wrangler containers delete <APP_ID>`, `npx wrangler containers images delete <image>`.
- Expected cost: the $5 Workers Paid plan; usage should stay within included allowances.

Drive both runs from a europe-west1 caller so numbers match the real platform path.
