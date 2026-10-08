import type { ChatDatabase } from "../chat/database.js";

export interface AoedeBindingTable {
  owner_type: "personal" | "organization";
  owner_id: string;
  runtime_scope: string;
  project_scope: string;
  chat_id: string | null;
}
export interface AoedeBootstrapRequestsTable {
  owner_type: "personal" | "organization";
  owner_id: string;
  runtime_scope: string;
  request_id: string;
  semantic_hash: string;
  /** No cascading FK: deleting history must not permit a request to replay creation. */
  created_chat_id: string;
}
export type AoedeDatabase = ChatDatabase & {
  aoede_bindings: AoedeBindingTable;
  aoede_bootstrap_requests: AoedeBootstrapRequestsTable;
};
