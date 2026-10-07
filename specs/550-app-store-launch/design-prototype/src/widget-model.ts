export const widgetCatalog = [
  { id: 'weather', name: 'Weather', description: 'An atmospheric glance at the day.', category: 'personal', glyph: 'atlas' },
  { id: 'agenda', name: 'Agenda', description: 'The next meeting, with breathing room.', category: 'business', glyph: 'agenda' },
  { id: 'clock', name: 'Clock', description: 'A quiet, generous view of time.', category: 'personal', glyph: 'subscriptions' },
  { id: 'spending', name: 'Spending', description: 'A small window into your month.', category: 'personal', glyph: 'folio' },
  { id: 'focus', name: 'Focus', description: 'Give one thing your attention.', category: 'personal', glyph: 'focus' },
  { id: 'notes', name: 'Notes', description: 'Keep a thought close by.', category: 'business', glyph: 'briefs' },
  { id: 'tasks', name: 'Tasks', description: 'A useful next step, always in view.', category: 'business', glyph: 'projects' },
  { id: 'reading', name: 'Reading', description: 'Make room for something interesting.', category: 'personal', glyph: 'briefs' },
] as const;
export type WidgetId = typeof widgetCatalog[number]['id'];
export type WidgetScope = 'all' | 'personal' | 'business';
export const initialWidgets: WidgetId[] = ['weather', 'agenda', 'clock', 'spending', 'focus', 'notes'];
export type WidgetAction = { type: 'add'; id: unknown } | { type: 'remove'; id: unknown } | { type: 'move'; id: unknown; direction: unknown; scope?: WidgetScope } | { type: 'reset' };
export function normalizeWidgets(input: unknown): WidgetId[] {
  if (!Array.isArray(input)) return [];
  // Finite catalog caps both retained state and normalization work, even for malformed inputs.
  const candidates = input.slice(0, 128);
  return widgetCatalog.filter(widget => candidates.includes(widget.id)).map(widget => widget.id)
    .toSorted((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
}
export function updateWidgets(input: readonly WidgetId[], action: WidgetAction): WidgetId[] {
  const state = normalizeWidgets(input);
  if (action.type === 'reset') return [...initialWidgets];
  const id = widgetCatalog.find(widget => widget.id === action.id)?.id;
  if (!id) return state;
  if (action.type === 'add') return state.includes(id) ? state : [...state, id];
  if (action.type === 'remove') return state.filter(value => value !== id);
  if (action.direction !== -1 && action.direction !== 1) return state;
  const order = action.scope === 'personal' || action.scope === 'business' ? visibleWidgets(state, action.scope) : state;
  const index = order.indexOf(id), target = index + action.direction;
  if (index < 0 || target < 0 || target >= order.length) return state;
  const from = state.indexOf(id), to = state.indexOf(order[target]);
  [state[from], state[to]] = [state[to], state[from]];
  return state;
}
export function visibleWidgets(input: unknown, scope: WidgetScope): WidgetId[] {
  return normalizeWidgets(input).filter(id => scope === 'all' || widgetCatalog.find(widget => widget.id === id)?.category === scope);
}
