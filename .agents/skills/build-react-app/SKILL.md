---
name: build-react-app
description: Build a React module with Vite, TypeScript, and theme integration Triggers: react app, react module, build react, vite app. Examples: build me a react app for tracking habits; create a react module for my bookmarks; make a react dashboard for my expenses.
---

# Build React App

## Component Architecture Patterns

### Single Page (default)
One App.tsx with all logic. Use for simple tools with one view.

### Multi-View with Tabs
```tsx
const [tab, setTab] = useState<"list" | "add" | "settings">("list");
return (
  <div>
    <nav className="tabs">
      {(["list", "add", "settings"] as const).map(t => (
        <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
      ))}
    </nav>
    {tab === "list" && <ListView />}
    {tab === "add" && <AddView />}
    {tab === "settings" && <SettingsView />}
  </div>
);
```

### Sidebar + Content
```tsx
<div className="layout">
  <aside className="sidebar">{/* nav items */}</aside>
  <main className="content">{/* selected view */}</main>
</div>
```

## State Management

### Simple (useState)
For apps with < 5 state variables. Direct useState for each piece of state.

### Complex (useReducer)
For apps with related state transitions (todo list, form wizard, game state):
```tsx
type Action = { type: "add"; item: Item } | { type: "remove"; id: string } | { type: "toggle"; id: string };
function reducer(state: Item[], action: Action): Item[] {
  switch (action.type) {
    case "add": return [...state, action.item];
    case "remove": return state.filter(i => i.id !== action.id);
    case "toggle": return state.map(i => i.id === action.id ? { ...i, done: !i.done } : i);
  }
}
```

## Bridge API for Persistent Data

Read: `fetch('/api/bridge/data?app=<name>&key=<key>').then(r => r.json())`
Write: `fetch('/api/bridge/data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({app:'<name>',key:'<key>',value: data}) })`

Always wrap in useEffect for initial load:
```tsx
useEffect(() => {
  fetch(`/api/bridge/data?app=${APP_NAME}&key=items`)
    .then(r => r.ok ? r.json() : { value: [] })
    .then(d => setItems(d.value ?? []));
}, []);
```

## Theme CSS Variables

Always include in App.css:
```css
:root {
  --bg: #0a0a0a; --fg: #ededed; --accent: #6c5ce7;
  --surface: #1a1a2e; --border: #2a2a3a;
}
body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
button { background: var(--accent); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
button:hover { opacity: 0.9; }
input, textarea { background: var(--surface); color: var(--fg); border: 1px solid var(--border); padding: 8px; border-radius: 6px; }
```

## Common Pitfalls
- Always set `base: "./"` in vite.config.ts (apps served from subpath)
- Use `pnpm install --prefer-offline` for faster installs
- Verify `dist/index.html` exists after build
- Don't import from node_modules paths directly in HTML -- use src/ imports
- Keep App.tsx under 300 lines; split into components if larger


## Matrix OS Context

- **Category**: builder
- **Channels**: web
- **Composable with**: app-builder
- **Example prompts**: build me a react app for tracking habits; create a react module for my bookmarks; make a react dashboard for my expenses
