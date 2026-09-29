import type { OrganizationAdminRequest, OrganizationAdminRepository } from "./admin-repository.js";
import type { ClerkOrganizationAdmin } from "./clerk-admin-client.js";
import type { OrganizationMembershipProjection } from "./projection.js";

const INTERVAL_MS = 10_000;
const SETTLE_MS = 2 * 60_000;
const REVIEW_MS = 10 * 60_000;
const FAIL_MS = 24 * 60 * 60_000;
const MAX_CONCURRENT = 4;

export class OrganizationCreationFinisher {
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: {
    repository: OrganizationAdminRepository;
    clerk?: ClerkOrganizationAdmin;
    projection: OrganizationMembershipProjection;
    now?: () => Date;
    startTimers?: boolean;
  }) {
    this.now = options.now ?? (() => new Date());
    if (options.startTimers) {
      this.timer = setInterval(() => {
        void this.runOnce().catch((error: unknown) => {
          console.warn("[organizations] creation finisher failed", error instanceof Error ? error.name : "UnknownError");
        });
      }, INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  async runOnce(): Promise<void> {
    if (this.closed) return;
    if (this.running) return this.running;
    const work = async () => {
      // Lease only work we can start now; a queued batch could outlive its lease.
      const requests = await this.options.repository.claimDue(MAX_CONCURRENT);
      await Promise.all(requests.map(async (request) => {
        try {
          await this.finish(request);
        } catch (error: unknown) {
          console.warn("[organizations] creation request deferred", error instanceof Error ? error.name : "UnknownError");
          await this.options.repository.defer(request, INTERVAL_MS);
        }
      }));
    };
    this.running = work().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async finish(request: OrganizationAdminRequest): Promise<void> {
    const ageMs = this.now().getTime() - request.createdAt.getTime();
    if (ageMs >= FAIL_MS) {
      await this.options.repository.markFailed(request);
      console.warn("[organizations] creation request expired", request.state);
      return;
    }
    if (request.state === "created") {
      await this.reconcile(request);
      return;
    }
    if (request.state !== "pending") return;
    if (!this.options.clerk) {
      if (ageMs >= REVIEW_MS) {
        await this.options.repository.markNeedsReview(request);
        console.warn("[organizations] creation client unavailable; request needs review");
      } else await this.options.repository.defer(request, INTERVAL_MS);
      return;
    }
    const lookup = await this.options.clerk.findCreatedOrganization({
      actorId: request.actorId, requestId: request.clientRequestId, createdAt: request.createdAt,
    });
    if (lookup.kind === "inconclusive") {
      if (ageMs >= REVIEW_MS) {
        await this.options.repository.markNeedsReview(request);
        console.warn("[organizations] creation marker lookup needs review");
      } else {
        await this.options.repository.defer(request, INTERVAL_MS);
      }
      return;
    }
    if (lookup.kind === "absent" && ageMs < SETTLE_MS) {
      await this.options.repository.defer(request, SETTLE_MS - ageMs);
      return;
    }
    const organizationId = lookup.kind === "found" ? lookup.organizationId
      : (await this.options.clerk.createOrganization({
        actorId: request.actorId, name: request.name, requestId: request.clientRequestId,
      })).organizationId;
    await this.options.repository.markCreated(request, organizationId);
    await this.reconcile({ ...request, state: "created", organizationId });
  }

  private async reconcile(request: OrganizationAdminRequest): Promise<void> {
    if (!request.organizationId) throw new Error("Created request lacks organization ID");
    const verified = (await this.options.projection.reconcile(request.organizationId)).verified
      && await this.options.projection.isCurrentMember({ organizationId: request.organizationId, actorId: request.actorId });
    if (verified) await this.options.repository.markListed(request);
    else await this.options.repository.defer(request, INTERVAL_MS);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
