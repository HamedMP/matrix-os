# Healing Strategies

Common failure patterns for Matrix OS modules and how to fix them.

## Diagnosis Steps

1. Read the module's manifest.json for port, health endpoint, entry point
2. Read the entry point file for syntax errors or missing imports
3. Check if node_modules/ exists (if package.json is present)
4. Try curling the health endpoint to get the actual error response
5. Check for port conflicts: another module might claim the same port

## Pattern: Server Crash (Syntax Error)

Symptoms: Health check returns ECONNREFUSED (server not running)

Diagnosis: Read the entry point file, look for syntax errors, missing semicolons, unclosed brackets, or invalid imports.

Fix template:
- Identify the syntax error location
- Apply minimal correction (fix the specific line)
- Do not refactor surrounding code

## Pattern: Server Crash (Missing Import)

Symptoms: ECONNREFUSED, module has dependencies

Diagnosis: Check if the import references an installed package. Look in package.json dependencies vs actual imports.

Fix:
- If package exists in package.json but node_modules is missing: `npm install`
- If import references a package not in package.json: add it and install

## Pattern: Port Conflict

Symptoms: EADDRINUSE error, or health check connects but gets wrong response

Diagnosis: The port in manifest.json might conflict with another running module. Check system/modules.json for port assignments.

Fix:
- Assign a new unused port (check modules.json for taken ports)
- Update both manifest.json and the server code to use the new port
- Update the module entry in system/modules.json

## Pattern: Health Endpoint Missing

Symptoms: HTTP 404 on the health path

Diagnosis: Server runs but the /health route is not defined.

Fix for Hono server:
```js
app.get('/health', (c) => c.json({ status: 'ok' }));
```

Fix for Express server:
```js
app.get('/health', (req, res) => res.json({ status: 'ok' }));
```

Fix for plain Node http server:
```js
if (req.url === '/health') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
  return;
}
```

## Pattern: Bad Config (Malformed JSON)

Symptoms: Module crashes on startup reading config

Diagnosis: Read manifest.json or data/*.json files, look for JSON parse errors (trailing commas, missing quotes, unescaped characters).

Fix:
- Correct the JSON syntax
- Validate with JSON.parse() mentally before saving

## Pattern: Missing Dependencies

Symptoms: "Cannot find module" or "MODULE_NOT_FOUND" errors

Diagnosis: package.json exists but node_modules/ is absent or incomplete.

Fix:
```bash
cd ~/modules/<name> && npm install
```

## General Rules

- Always make the smallest fix possible
- A backup already exists at ~/.backup/<module-name>/ -- do not create another
- After fixing, verify by curling the health endpoint
- If the fix fails after 2 attempts, report failure and let the operator intervene
- Never modify files outside the module's directory
- Preserve existing code style and conventions
