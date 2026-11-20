import type { Kysely, Selectable } from "kysely";
import {
  BOARD_GRANT_PERMISSIONS, type BoardGrant, type BoardGrantExplanation, type BoardGrantPermission, type CreateGrantRequest,
} from "@matrix-os/contracts/message-board";
import type { BoardGrantsTable, MessageBoardDatabase } from "./database.js";
import { boardFail } from "./errors.js";
import { newBoardId, toIso, type BoardTrx } from "./rows.js";
import type { BoardCaller, MessageBoardService } from "./service.js";

type Executor = Kysely<MessageBoardDatabase> | BoardTrx;
type GrantRow = Selectable<BoardGrantsTable>;

/** What an active member gets everywhere unless a grant says otherwise (spec 2700 section 8). */
export const DEFAULT_MEMBER_PERMISSIONS: readonly BoardGrantPermission[] = ["read", "post", "react", "label"];
const MAX_GRANTS_PER_BOARD = 500;

/** Grants apply to callers acting for someone other than the owner; the owner and the owner's agents have everything. */
export function grantSubject(caller: BoardCaller): string[] | null {
  if (!caller.principal || caller.principal === caller.ownerId) return null;
  return [...new Set([`user:${caller.principal}`, caller.actor.id])];
}

function patternRank(pattern: string, channel: string): number | null {
  if (pattern === channel) return 1_000_000;
  if (pattern === "*") return 0;
  if (pattern.endsWith("/")) {
    const prefix = pattern.slice(0, -1);
    if (channel === prefix || channel.startsWith(pattern)) return pattern.length;
  }
  return null;
}

function toGrant(row: GrantRow): BoardGrant {
  const permissions = (typeof row.permissions === "string" ? JSON.parse(row.permissions) : row.permissions) as BoardGrantPermission[];
  return { id: row.id, principal: row.principal, channel: row.pattern, permissions, createdBy: row.created_by, createdAt: toIso(row.created_at)! };
}

/**
 * Resolution: among grants that name this subject or `*`, the most specific
 * pattern wins (exact, then longest subtree, then `*`); at that pattern a grant
 * naming the subject beats `*`; grants at the same level add up. An empty
 * permission list is a closing grant.
 */
export function resolveGrants(grants: readonly BoardGrant[], subject: readonly string[], channel: string): {
  pattern: string | null; permissions: BoardGrantPermission[]; grants: BoardGrant[];
} {
  const applicable = grants.flatMap((grant) => {
    if (grant.principal !== "*" && !subject.includes(grant.principal)) return [];
    const rank = patternRank(grant.channel, channel);
    return rank === null ? [] : [{ grant, rank }];
  });
  if (applicable.length === 0) return { pattern: null, permissions: [...DEFAULT_MEMBER_PERMISSIONS], grants: [] };
  const best = Math.max(...applicable.map((item) => item.rank));
  const atPattern = applicable.filter((item) => item.rank === best).map((item) => item.grant);
  const named = atPattern.filter((grant) => grant.principal !== "*");
  const deciding = named.length > 0 ? named : atPattern;
  const permissions = BOARD_GRANT_PERMISSIONS.filter((permission) => deciding.some((grant) => grant.permissions.includes(permission)));
  return { pattern: deciding[0]!.channel, permissions, grants: deciding };
}

/** Grant storage, explanation and the access checks the board service calls. */
export class BoardGrantService {
  constructor(private readonly board: MessageBoardService) {}

  async listForBoard(executor: Executor, boardId: string): Promise<BoardGrant[]> {
    const rows = await executor.selectFrom("board_grants").selectAll().where("board_id", "=", boardId)
      .orderBy("pattern").orderBy("principal").limit(MAX_GRANTS_PER_BOARD).execute();
    return rows.map(toGrant);
  }

  async list(caller: BoardCaller, boardName: string | undefined): Promise<BoardGrant[]> {
    const board = await this.board.resolveBoard(caller.ownerId, boardName);
    return this.listForBoard(this.board.db, board.id);
  }

  /** One grant per principal at the pattern; writing again replaces its permissions. */
  async create(caller: BoardCaller, boardName: string | undefined, input: CreateGrantRequest): Promise<BoardGrant[]> {
    return this.board.write(caller, boardName, async (ctx) => {
      return this.writeGrants(ctx.trx, ctx.board.id, caller, input.principals, input.channel, input.permissions, ctx.now);
    });
  }

  async writeGrants(trx: BoardTrx, boardId: string, caller: BoardCaller, principals: readonly string[], pattern: string,
    permissions: readonly BoardGrantPermission[], now: Date): Promise<BoardGrant[]> {
    // Every writer (grants and private channels) shares the per-board cap, so reads never truncate.
    const existing = await trx.selectFrom("board_grants").select(["principal", "pattern"]).where("board_id", "=", boardId).execute();
    const added = principals.filter((principal) => !existing.some((row) => row.principal === principal && row.pattern === pattern)).length;
    if (existing.length + added > MAX_GRANTS_PER_BOARD) boardFail("limit_reached");
    const written: BoardGrant[] = [];
    for (const principal of principals) {
      const row = await trx.insertInto("board_grants").values({
        id: newBoardId("grt"), owner_id: caller.ownerId, board_id: boardId, principal, pattern,
        permissions: JSON.stringify([...new Set(permissions)]), created_by: caller.actor.id, created_at: now,
      }).onConflict((oc) => oc.columns(["board_id", "principal", "pattern"]).doUpdateSet({ permissions: JSON.stringify([...new Set(permissions)]) }))
        .returningAll().executeTakeFirstOrThrow();
      written.push(toGrant(row));
    }
    return written;
  }

  async patch(caller: BoardCaller, boardName: string | undefined, id: string, permissions: BoardGrantPermission[]): Promise<BoardGrant> {
    return this.board.write(caller, boardName, async (ctx) => {
      const row = await ctx.trx.updateTable("board_grants").set({ permissions: JSON.stringify([...new Set(permissions)]) })
        .where("id", "=", id).where("board_id", "=", ctx.board.id).returningAll().executeTakeFirst();
      return toGrant(row ?? boardFail("not_found"));
    });
  }

  async remove(caller: BoardCaller, boardName: string | undefined, id: string): Promise<void> {
    await this.board.write(caller, boardName, async (ctx) => {
      const deleted = await ctx.trx.deleteFrom("board_grants").where("id", "=", id).where("board_id", "=", ctx.board.id).returning("id").execute();
      if (deleted.length === 0) boardFail("not_found");
    });
  }

  async explain(caller: BoardCaller, boardName: string | undefined, channel: string, principal?: string): Promise<BoardGrantExplanation> {
    const board = await this.board.resolveBoard(caller.ownerId, boardName);
    const subjectPrincipal = principal ?? caller.actor.id;
    if (subjectPrincipal === `user:${caller.ownerId}`) {
      return { channel, principal: subjectPrincipal, pattern: null, permissions: [...BOARD_GRANT_PERMISSIONS], grants: [], source: "owner" };
    }
    const resolved = resolveGrants(await this.listForBoard(this.board.db, board.id), [subjectPrincipal], channel);
    return { channel, principal: subjectPrincipal, ...resolved, source: resolved.pattern === null ? "default" : "grants" };
  }

  /** Throws `forbidden` when grants deny `permission` on `channel` for this caller. */
  async require(executor: Executor, caller: BoardCaller, boardId: string, channel: string, permission: BoardGrantPermission): Promise<void> {
    const subject = grantSubject(caller);
    if (!subject) return;
    const { permissions } = resolveGrants(await this.listForBoard(executor, boardId), subject, channel);
    if (!permissions.includes(permission)) boardFail("forbidden");
  }

  /** Channels this caller may read, or null when nothing is restricted. */
  async readable(executor: Executor, caller: BoardCaller, boardId: string, channels: readonly string[]): Promise<string[] | null> {
    const subject = grantSubject(caller);
    if (!subject) return null;
    const grants = await this.listForBoard(executor, boardId);
    return channels.filter((channel) => resolveGrants(grants, subject, channel).permissions.includes("read"));
  }
}
