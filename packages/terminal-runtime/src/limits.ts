export const MAX_TERMINAL_SNAPSHOT_ANSI_BYTES = 5 * 1024 * 1024;

// Zellij's ANSI string and its line arrays describe the same retained output.
// JSON can expand each control character to six bytes (for example `\\u0001`),
// so reserve that worst case for both representations plus bounded envelope
// overhead. This remains a finite per-tab disk/read limit.
export const MAX_TERMINAL_SNAPSHOT_BYTES =
  (MAX_TERMINAL_SNAPSHOT_ANSI_BYTES * 6 * 2) + (4 * 1024 * 1024);

// Requests contain only bounded control/input frames. Responses may contain a
// full validated snapshot, so they get a separate finite allowance without
// increasing the server's untrusted inbound allocation limit.
export const MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES =
  MAX_TERMINAL_SNAPSHOT_BYTES + (1024 * 1024);
