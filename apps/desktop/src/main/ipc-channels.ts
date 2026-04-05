export const INVOKE_CHANNELS = [
  "tab:create",
  "tab:close",
  "tab:switch",
  "tab:list",
  "tab:reload",
  "tab:duplicate",
  "sidebar:getApps",
  "sidebar:setPinned",
  "sidebar:setExpanded",
  "container:start",
  "container:stop",
  "container:upgrade",
  "container:status",
  "update:check",
  "update:install",
  "desktop:getConnectionInfo",
  "desktop:requestUpgrade",
] as const

export const SEND_CHANNELS = [
  "connection-changed",
  "tabs-changed",
  "apps-changed",
  "update-available",
  "update-progress",
  "update-downloaded",
  "upgrade-progress",
  "shortcut",
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type SendChannel = (typeof SEND_CHANNELS)[number]
