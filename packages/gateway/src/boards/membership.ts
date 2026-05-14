import { sql, type Kysely } from "kysely";
import {
  AddBoardMemberSchema,
  BOARD_MEMBER_LIMIT,
  BoardMemberSchema,
  type AddBoardMemberInput,
  type BoardMember,
} from "./contracts.js";

export interface BoardMembershipService {
  bootstrap?(): Promise<void>;
  listMembers(ownerId: string, projectSlug: string): Promise<BoardMember[]>;
  addMember(ownerId: string, projectSlug: string, input: AddBoardMemberInput): Promise<BoardMember>;
  removeMember(ownerId: string, projectSlug: string, userId: string): Promise<void>;
  canReadBoard(ownerId: string, projectSlug: string, principalUserId: string): Promise<boolean>;
  canWriteBoard(ownerId: string, projectSlug: string, principalUserId: string): Promise<boolean>;
}

const MAX_BOARDS = 1_000;

export class BoardMemberLimitExceededError extends Error {
  constructor() {
    super("Board member limit exceeded");
    this.name = "BoardMemberLimitExceededError";
  }
}

function boardKey(ownerId: string, projectSlug: string): string {
  return `${ownerId}\u0000${projectSlug}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowMember(row: Record<string, unknown>): BoardMember {
  const value = row.member;
  return BoardMemberSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

export function createMemoryBoardMembershipService(): BoardMembershipService {
  const boards = new Map<string, Map<string, BoardMember>>();

  function touchBoard(ownerId: string, projectSlug: string): Map<string, BoardMember> {
    const key = boardKey(ownerId, projectSlug);
    const existing = boards.get(key);
    if (existing) {
      boards.delete(key);
      boards.set(key, existing);
      return existing;
    }
    if (boards.size >= MAX_BOARDS) {
      const oldestKey = boards.keys().next().value;
      if (typeof oldestKey === "string") boards.delete(oldestKey);
    }
    const members = new Map<string, BoardMember>();
    boards.set(key, members);
    return members;
  }

  function readBoard(ownerId: string, projectSlug: string): Map<string, BoardMember> | undefined {
    return boards.get(boardKey(ownerId, projectSlug));
  }

  return {
    async listMembers(ownerId, projectSlug) {
      return Array.from(readBoard(ownerId, projectSlug)?.values() ?? []);
    },

    async addMember(ownerId, projectSlug, input) {
      const parsed = AddBoardMemberSchema.parse(input);
      const members = touchBoard(ownerId, projectSlug);
      if (!members.has(parsed.userId) && members.size >= BOARD_MEMBER_LIMIT) {
        throw new BoardMemberLimitExceededError();
      }
      const member: BoardMember = {
        projectSlug,
        userId: parsed.userId,
        role: parsed.role,
        addedBy: ownerId,
        addedAt: nowIso(),
      };
      members.set(member.userId, member);
      return member;
    },

    async removeMember(ownerId, projectSlug, userId) {
      readBoard(ownerId, projectSlug)?.delete(userId);
    },

    async canReadBoard(ownerId, projectSlug, principalUserId) {
      if (ownerId === principalUserId) return true;
      return readBoard(ownerId, projectSlug)?.has(principalUserId) ?? false;
    },

    async canWriteBoard(ownerId, projectSlug, principalUserId) {
      if (ownerId === principalUserId) return true;
      return readBoard(ownerId, projectSlug)?.get(principalUserId)?.role === "editor";
    },
  };
}

export class KyselyBoardMembershipService implements BoardMembershipService {
  constructor(private readonly db: Kysely<any>) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS shared_board_members (
        owner_id text NOT NULL,
        project_slug text NOT NULL,
        user_id text NOT NULL,
        role text NOT NULL,
        member jsonb NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (owner_id, project_slug, user_id)
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_shared_board_members_user
      ON shared_board_members (user_id, updated_at DESC)
    `.execute(this.db);
  }

  async listMembers(ownerId: string, projectSlug: string): Promise<BoardMember[]> {
    const rows = await this.db
      .selectFrom("shared_board_members")
      .select(["member"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .orderBy("created_at", "asc")
      .limit(BOARD_MEMBER_LIMIT)
      .execute() as Record<string, unknown>[];
    return rows.map(rowMember);
  }

  async addMember(ownerId: string, projectSlug: string, input: AddBoardMemberInput): Promise<BoardMember> {
    const parsed = AddBoardMemberSchema.parse(input);
    const member: BoardMember = {
      projectSlug,
      userId: parsed.userId,
      role: parsed.role,
      addedBy: ownerId,
      addedAt: nowIso(),
    };
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("shared_board_members")
        .select(["user_id"])
        .where("owner_id", "=", ownerId)
        .where("project_slug", "=", projectSlug)
        .where("user_id", "=", member.userId)
        .executeTakeFirst();
      if (!existing) {
        const countRow = await trx
          .selectFrom("shared_board_members")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("owner_id", "=", ownerId)
          .where("project_slug", "=", projectSlug)
          .executeTakeFirst();
        const count = Number(countRow?.count ?? 0);
        if (count >= BOARD_MEMBER_LIMIT) throw new BoardMemberLimitExceededError();
      }
      await trx
        .insertInto("shared_board_members")
        .values({
          owner_id: ownerId,
          project_slug: projectSlug,
          user_id: member.userId,
          role: member.role,
          member: JSON.stringify(member),
        })
        .onConflict((oc) => oc.columns(["owner_id", "project_slug", "user_id"]).doUpdateSet({
          role: member.role,
          member: JSON.stringify(member),
          updated_at: sql`now()`,
        }))
        .execute();
    });
    return member;
  }

  async removeMember(ownerId: string, projectSlug: string, userId: string): Promise<void> {
    await this.db
      .deleteFrom("shared_board_members")
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("user_id", "=", userId)
      .execute();
  }

  async canReadBoard(ownerId: string, projectSlug: string, principalUserId: string): Promise<boolean> {
    if (ownerId === principalUserId) return true;
    const row = await this.db
      .selectFrom("shared_board_members")
      .select(["role"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("user_id", "=", principalUserId)
      .executeTakeFirst();
    return Boolean(row);
  }

  async canWriteBoard(ownerId: string, projectSlug: string, principalUserId: string): Promise<boolean> {
    if (ownerId === principalUserId) return true;
    const row = await this.db
      .selectFrom("shared_board_members")
      .select(["role"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("user_id", "=", principalUserId)
      .executeTakeFirst() as { role?: string } | undefined;
    return row?.role === "editor";
  }
}
