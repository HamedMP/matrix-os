export const DEFAULT_HERMES_MODEL = "Hermes default";
export const DEFAULT_HERMES_CHANNELS = ["shell"];

export function createChannelConfiguredPrompt(text: string, channels: string[]) {
  const normalizedChannels = channels.toSorted();
  const usesDefaultChannels =
    normalizedChannels.length === DEFAULT_HERMES_CHANNELS.length &&
    normalizedChannels.every((channel, index) => channel === DEFAULT_HERMES_CHANNELS[index]);
  if (usesDefaultChannels) return text;
  return [
    "Use these Matrix channels for this response only:",
    `Enabled channels: ${normalizedChannels.length > 0 ? normalizedChannels.join(", ") : "none"}`,
    "",
    text,
  ].join("\n");
}

export function createHermesConfiguredPrompt(text: string, _model: string, _channels: string[]) {
  const normalizedChannels = _channels.toSorted();
  const isDefaultSetup =
    _model === DEFAULT_HERMES_MODEL &&
    normalizedChannels.length === DEFAULT_HERMES_CHANNELS.length &&
    normalizedChannels.every((channel, index) => channel === DEFAULT_HERMES_CHANNELS[index]);
  if (isDefaultSetup) return text;

  const enabledChannels = normalizedChannels.length > 0 ? normalizedChannels.join(", ") : "none";
  return [
    "Use this Hermes setup for this response only:",
    `Agent mode: ${_model}`,
    `Enabled channels: ${enabledChannels}`,
    "",
    text,
  ].join("\n");
}
