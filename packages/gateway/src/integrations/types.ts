export interface ActionParam {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
}

export interface DirectApi {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string | ((params: Record<string, unknown>) => string);
  mapParams?: (params: Record<string, unknown>) => Record<string, string>;
  mapBody?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** Header names and values are compile-time registry data, never caller input. */
  staticHeaders?: Readonly<Record<string, string>>;
}

export type IntegrationActionRisk = "read" | "write" | "destructive";
export type IntegrationConnectorKind = "pipedream" | "mcp_preset";

export interface ServiceAction {
  description: string;
  params: Record<string, ActionParam>;
  risk: IntegrationActionRisk;
  componentKey?: string;
  directApi?: DirectApi;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  category: string;
  connectorKind: IntegrationConnectorKind;
  pipedreamApp?: string;
  mcpPreset?: {
    url: string;
    authMode: "oauth";
  };
  icon: string;
  logoUrl: string;
  actions: Record<string, ServiceAction>;
}

export interface ConnectRequest {
  service: string;
  label?: string;
}

export interface CallRequest {
  service: string;
  action: string;
  params?: Record<string, unknown>;
  label?: string;
}

export interface ConnectResult {
  url: string;
  service: string;
}

export interface CallResult {
  data: unknown;
  service: string;
  action: string;
}
