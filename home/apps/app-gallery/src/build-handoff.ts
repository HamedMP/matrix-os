export interface BuildBridge { generate?: (context: string) => void | Promise<unknown> }

/** Uses the host's authenticated app task channel; no credentials leave the host. */
export async function requestAppBuild(bridge: BuildBridge, input: string): Promise<void> {
  const prompt = input.trim();
  if (!prompt || prompt.length > 2000 || !bridge.generate) throw new Error('Build unavailable');
  await bridge.generate(`[BUILD] Build an app for my Matrix computer: ${prompt}. Use my connected tools only after I choose the accounts and approve imports. Make it work in Web Desktop, Web Canvas, Electron Desktop and mobile.`);
}
