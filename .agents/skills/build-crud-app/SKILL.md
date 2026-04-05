---
name: build-crud-app
description: Build CRUD apps with data persistence via the bridge API Triggers: crud, list app, manage, tracker, organizer. Examples: build a contact manager; create a recipe organizer; make a bookmark tracker.
---

# Build CRUD App

## Data Schema Design

Data stored as JSON in `~/data/<app>/` via bridge API. Design a clear schema:

```tsx
interface Item {
  id: string;
  createdAt: number;
  updatedAt: number;
  // domain fields
}
```

Always include `id`, `createdAt`, `updatedAt` for every entity.
Generate IDs with: `crypto.randomUUID()` or `Date.now().toString(36)`

## Bridge API CRUD Operations

```tsx
const APP = "my-app";
const KEY = "items";

async function loadItems(): Promise<Item[]> {
  const r = await fetch(`/api/bridge/data?app=${APP}&key=${KEY}`);
  if (!r.ok) return [];
  const d = await r.json();
  return d.value ?? [];
}

async function saveItems(items: Item[]): Promise<void> {
  await fetch('/api/bridge/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: APP, key: KEY, value: items }),
  });
}
```

## List/Detail View Pattern

```tsx
function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => { loadItems().then(setItems); }, []);

  if (selected && !editing) return <DetailView item={selected} onBack={() => setSelected(null)} onEdit={() => setEditing(true)} onDelete={handleDelete} />;
  if (editing) return <EditForm item={selected} onSave={handleSave} onCancel={() => setEditing(false)} />;
  return <ListView items={items} onSelect={setSelected} onAdd={() => { setSelected(null); setEditing(true); }} />;
}
```

## Form Validation Pattern

```tsx
function EditForm({ item, onSave, onCancel }: Props) {
  const [name, setName] = useState(item?.name ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    onSave({ ...item, name, id: item?.id ?? crypto.randomUUID(), updatedAt: Date.now(), createdAt: item?.createdAt ?? Date.now() });
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>Name</label>
      <input value={name} onChange={e => setName(e.target.value)} />
      {errors.name && <span className="error">{errors.name}</span>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  );
}
```

## Optimistic Updates

Update local state immediately, persist in background:
```tsx
async function handleDelete(id: string) {
  const next = items.filter(i => i.id !== id);
  setItems(next);
  setSelected(null);
  await saveItems(next);
}

async function handleSave(item: Item) {
  const next = selected ? items.map(i => i.id === item.id ? item : i) : [...items, item];
  setItems(next);
  setEditing(false);
  setSelected(item);
  await saveItems(next);
}
```


## Matrix OS Context

- **Category**: builder
- **Channels**: web
- **Composable with**: app-builder, build-react-app
- **Example prompts**: build a contact manager; create a recipe organizer; make a bookmark tracker; build an inventory manager
