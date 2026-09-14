export type CustomMcpAuthMode = "none" | "oauth" | "bearer" | "api_key";
export type CustomMcpStatus =
  | "pending"
  | "auth_required"
  | "ready"
  | "degraded"
  | "disabled"
  | "action_required";
export type CustomMcpApproval = "always_ask" | "allow";

export interface CustomMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  approval: CustomMcpApproval;
  enabled: boolean;
}

export interface CustomMcpServer {
  id: string;
  name: string;
  url: string;
  authMode: CustomMcpAuthMode;
  status: CustomMcpStatus;
  enabled: boolean;
  revision: number;
  tools: CustomMcpTool[];
}

export interface CustomMcpProjectionTool {
  name: string;
  approval: CustomMcpApproval;
  enabled: boolean;
}

export interface CustomMcpServerProjection {
  id: string;
  name: string;
  url: string;
  authMode: CustomMcpAuthMode;
  enabled: boolean;
  revision: number;
  tools: CustomMcpProjectionTool[];
}

export interface CustomMcpProjectionFile {
  version: 1;
  servers: CustomMcpServerProjection[];
}
