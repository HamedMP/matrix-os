/** Connected-provider refreshes and presentation changes are not runtime entries. */
export function shouldOpenChatOnStartup(input: {
  settled: boolean;
  consumed: boolean;
  explicitLaunch: boolean;
  navigationChanged: boolean;
  chatOpen: boolean;
}): boolean {
  return input.settled && !input.consumed && !input.explicitLaunch
    && !input.navigationChanged && !input.chatOpen;
}
