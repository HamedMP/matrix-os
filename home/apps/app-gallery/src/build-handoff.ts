import { appGalleryBuildPrompt } from './generated-contract';

export interface BuildBridge { generate?: (context: string) => void | Promise<unknown> }

/** Uses the host's authenticated app task channel; no credentials leave the host. */
export async function requestAppBuild(bridge: BuildBridge, input: string): Promise<void> {
  const prompt = appGalleryBuildPrompt(input);
  if (!prompt || !bridge.generate) throw new Error('Build unavailable');
  await bridge.generate(prompt);
}
