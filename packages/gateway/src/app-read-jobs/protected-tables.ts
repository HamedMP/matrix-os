/** Reserved runtime authority tables. Generic app CRUD may read but never forge receipts/leases. */
export const READ_JOB_PROTECTED_TABLES = ["read_job_state", "read_job_runs", "read_job_snapshots"] as const;
const MUTATION_ACTIONS = ["insert", "bulkInsert", "update", "bulkUpdate", "delete"];
export function isReadJobTableMutation(table: string, action: string): boolean {
  return READ_JOB_PROTECTED_TABLES.some(name => name === table) && MUTATION_ACTIONS.includes(action);
}
export function assertAppTableWritable(table: string): void {
  if (READ_JOB_PROTECTED_TABLES.some(name => name === table)) throw new Error("App read job data is read-only");
}
