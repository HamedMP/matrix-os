// Desktop Plugins hub: integrations, MCP servers, skills, and the Matrix CLI
// in one sidebar destination. The orchestrator registers PluginsHub for the
// "plugins" tab kind; sections may also be rendered standalone.
export { default } from "./PluginsHub";
export { default as PluginsHub } from "./PluginsHub";
export { SkillsSection } from "./SkillsSection";
export { McpServersSection } from "./McpServersSection";
export { CliSection, CLI_BREW_INSTALL_COMMAND, CLI_NPM_INSTALL_COMMAND } from "./CliSection";
export { usePlugins, pluginsStore, type SkillsStatus } from "./plugins-store";
export { openPluginsTerminal, PLUGINS_TERMINAL_CWD } from "./open-plugins-terminal";
export { MAX_SKILLS, parseSkills, type SkillInfo } from "./types";
