export interface ActionParam {
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
}

export interface ServiceAction {
  description: string;
  params: Record<string, ActionParam>;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  category: string;
  pipedreamApp: string;
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
