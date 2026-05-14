# Desktop Bridge Contract

The desktop bridge is the only API exposed from the native desktop host into the Matrix shell renderer.

## Runtime Policy

`window.matrixDesktop.getRuntime(): Promise<DesktopRuntimePolicy>`

Response:

```json
{
  "appName": "Matrix OS",
  "matrixInstanceUrl": "https://alice.matrix-os.com",
  "gatewayUrl": "https://alice.matrix-os.com",
  "agentExecution": {
    "mode": "cloud",
    "localAgentsAllowed": false
  },
  "capabilities": {
    "matrixShell": true,
    "appLauncher": true,
    "cloudDevelopment": true,
    "linearTicketSync": true,
    "internalTickets": true,
    "symphonyRunner": true
  }
}
```

Rules:

- The bridge never exposes Node.js, filesystem, child process, shell execution, or local agent start capabilities.
- The bridge response is informative only; gateway remains the source of truth for allowed operations.
- URLs must be normalized and `http`/`https` only.

## External Navigation

`window.matrixDesktop.openExternal(url: string): Promise<{ ok: boolean }>`

Rules:

- Allows only `http` and `https` URLs.
- Rejects `file:`, `javascript:`, credential-bearing custom protocols, and malformed URLs.
- Matrix-origin URLs should remain inside the desktop shell unless an explicit external-open action is requested.

## Instance Configuration

`window.matrixDesktop.setInstance(target: string): Promise<{ ok: boolean }>`

Rules:

- Accepts only validated Matrix instance URLs.
- Stores local desktop connection preference only.
- Does not store Matrix credentials or provider secrets.
