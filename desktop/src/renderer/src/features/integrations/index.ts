// Desktop integrations module: Pipedream-backed third-party service
// connections through the gateway proxy routes /api/integrations*. The
// orchestrator registers IntegrationsSettingsSection in SettingsView and may
// drive integrationsStore.refresh() from anywhere else.
export {
  IntegrationsSettingsSection,
  type IntegrationsSettingsSectionProps,
} from "./IntegrationsSettingsSection";
export { default } from "./IntegrationsSettingsSection";
export { useIntegrations, integrationsStore, type IntegrationsStatus } from "./integrations-store";
export { DEFAULT_CONNECT_POLL_INTERVALS_MS, startConnectPoll, type ConnectPollOptions } from "./connect-poll";
export {
  MAX_AVAILABLE_INTEGRATIONS,
  MAX_CONNECTED_INTEGRATIONS,
  isValidConnectionId,
  isValidServiceId,
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  parseConnectUrl,
  type AvailableIntegration,
  type ConnectedIntegration,
} from "./types";
