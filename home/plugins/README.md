# Plugins

Place Matrix OS plugins here. Each plugin is a directory with a `matrixos.plugin.json` manifest.

## Plugin Structure

```
my-plugin/
  matrixos.plugin.json   # Required: plugin manifest
  index.ts               # Required: entry point with register() function
  package.json           # Optional: dependencies
```

## Manifest Format

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "configSchema": {}
}
```

## Entry Point

```typescript
import type { MatrixOSPluginApi } from "@matrix-os/gateway";

export function register(api: MatrixOSPluginApi) {
  api.registerTool({
    name: "my_tool",
    description: "What it does",
    schema: { input: { type: "string" } },
    execute: async (params) => ({
      content: [{ type: "text", text: `Result: ${params.input}` }],
    }),
  });
}
```
