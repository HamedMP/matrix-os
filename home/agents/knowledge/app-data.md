# App Data Layer

Matrix OS apps store data in Postgres via the `app_data` IPC tool. Apps declare their schema in `matrix.json` and the system auto-creates tables on boot.

## IMPORTANT: Always use the app_data tool

NEVER read or write files in `~/data/` directly. Always use the `app_data` IPC tool. The file-based path is deprecated and apps read from Postgres, not files.

## Structured Actions (Postgres-backed)

Apps with `storage.tables` in their `matrix.json` use structured queries:

### Find rows
```
app_data { action: "find", app: "todo", table: "tasks", filter: { done: false }, orderBy: { created_at: "desc" }, limit: 50 }
```

### Find one row by ID
```
app_data { action: "findOne", app: "todo", table: "tasks", id: "uuid-here" }
```

### Insert a row
```
app_data { action: "insert", app: "todo", table: "tasks", data: { text: "Buy milk", done: false, category: "shopping" } }
```
Returns `{ id: "generated-uuid" }`. The `id`, `created_at`, `updated_at` columns are auto-managed.

### Update a row
```
app_data { action: "update", app: "todo", table: "tasks", id: "uuid-here", data: { done: true } }
```

### Delete a row
```
app_data { action: "delete", app: "todo", table: "tasks", id: "uuid-here" }
```

### Count rows
```
app_data { action: "count", app: "todo", table: "tasks", filter: { done: false } }
```

### List all registered apps
```
app_data { action: "listApps" }
```

### Get app schema
```
app_data { action: "schema", app: "todo" }
```

## Filter Operators

Filters support MongoDB-style operators:
- Simple equality: `{ done: false }` or `{ category: "work" }`
- Comparison: `{ priority: { $gt: 1 } }`, `{ due: { $lte: "2026-03-23" } }`
- Set membership: `{ category: { $in: ["work", "personal"] } }`
- Pattern matching: `{ text: { $like: "%milk%" } }`, `{ text: { $ilike: "%milk%" } }`
- Null check: `{ due: null }` (IS NULL)
- Combined: `{ priority: { $gte: 1, $lte: 5 } }` (AND)

## Registered Apps and Their Tables

### todo
- **tasks**: text (text), done (boolean), due (timestamptz), category (text), priority (text)

### expense-tracker
- **expenses**: amount (float), description (text), category (text), date (timestamptz)

### notes
- **notes**: title (text), content (text), pinned (boolean)

### pomodoro
- **sessions**: duration (integer), type (text), completed (boolean)

## Legacy Actions (KV fallback)

For apps without `storage.tables`, use KV actions:
```
app_data { action: "read", app: "calculator", key: "history" }
app_data { action: "write", app: "calculator", key: "history", value: "[...]" }
app_data { action: "list", app: "calculator" }
```

## When building new apps

Always declare `storage.tables` in `matrix.json` for apps that persist data. Use the structured API (find/insert/update/delete), not the legacy KV API.

```json
{
  "name": "My App",
  "storage": {
    "tables": {
      "items": {
        "columns": {
          "title": "text",
          "done": "boolean",
          "priority": "integer"
        },
        "indexes": ["priority"]
      }
    }
  }
}
```

Column types: text, string, boolean, bool, integer, int, float, number, date, timestamptz, timestamp, json, jsonb, uuid.
