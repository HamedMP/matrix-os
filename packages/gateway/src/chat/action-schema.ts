import { type ColumnType } from "kysely";
import type { ChatDatabase } from "./database.js";
export interface ActionDatabase {
  chat_action_operations: {
    id: string;
    chat_id: string;
    run_id: string;
    owner_type: string;
    owner_id: string;
    state: string;
    revision: number;
    operation: ColumnType<unknown, unknown, unknown>;
    decision_request_id: string | null;
    decision: string | null;
  };
}
export type ActionChatDatabase = ChatDatabase & ActionDatabase;
