---
name: build-dashboard
description: Build data visualization dashboards with charts, tables, and KPI cards
triggers:
  - dashboard
  - analytics
  - charts
  - data visualization
  - metrics
category: builder
tools_needed:
  - Bash
  - Write
  - Read
channel_hints:
  - web
examples:
  - build me a fitness dashboard
  - create an analytics dashboard for my expenses
  - make a dashboard to track my reading progress
composable_with:
  - app-builder
  - build-react-app
---

# Build Dashboard

## Chart Libraries

### React (default for dashboards): recharts
Add to package.json dependencies: `"recharts": "^2.15.0"`

```tsx
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

<ResponsiveContainer width="100%" height={300}>
  <LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
    <XAxis dataKey="date" stroke="var(--fg)" />
    <YAxis stroke="var(--fg)" />
    <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
    <Line type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} />
  </LineChart>
</ResponsiveContainer>
```

### HTML apps: Chart.js via CDN
```html
<script src="https://unpkg.com/chart.js@4"></script>
<canvas id="chart"></canvas>
<script>
new Chart(document.getElementById('chart'), {
  type: 'line',
  data: { labels: [...], datasets: [{ data: [...], borderColor: 'var(--accent)' }] },
  options: { responsive: true }
});
</script>
```

## KPI Cards
```tsx
function KpiCard({ label, value, change }: { label: string; value: string; change?: string }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {change && <span className={`kpi-change ${change.startsWith('+') ? 'up' : 'down'}`}>{change}</span>}
    </div>
  );
}
```

```css
.kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
.kpi-label { font-size: 0.85rem; opacity: 0.7; display: block; margin-bottom: 0.5rem; }
.kpi-value { font-size: 2rem; font-weight: 700; }
.kpi-change { font-size: 0.85rem; margin-left: 0.5rem; }
.kpi-change.up { color: #2ecc71; }
.kpi-change.down { color: #e74c3c; }
```

## Responsive Grid Layout
```css
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
  padding: 1rem;
}
.chart-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.5rem;
  grid-column: span 2;
}
```

## Data Refresh Pattern

`/api/bridge/data` stores string values -- always `JSON.parse(d.value)` on read.

```tsx
const [data, setData] = useState<DataPoint[]>([]);
const [refreshInterval] = useState(30000);

useEffect(() => {
  const load = () =>
    fetch(`/api/bridge/data?app=${APP}&key=metrics`)
      .then(r => r.json())
      .then(d => {
        if (!d.value) return setData([]);
        try { setData(JSON.parse(d.value)); } catch { setData([]); }
      });
  load();
  const id = setInterval(load, refreshInterval);
  return () => clearInterval(id);
}, [refreshInterval]);
```
