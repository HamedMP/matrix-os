type SearchableApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  detail: string;
  benefits: readonly string[];
};

const keywords: Readonly<Record<string, string>> = {
  folio: 'expenses receipts invoices spending money budget',
  atlas: 'trips travel destinations itinerary flights bookings holidays',
  agenda: 'calendar schedule events planner',
  subscriptions: 'renewals recurring bills subscriptions',
  focus: 'timer pomodoro concentration productivity',
  'meeting-briefs': 'meeting notes preparation attendees',
  projects: 'tasks issues kanban milestones work',
  revenue: 'payments income invoices earnings',
};

export const searchSuggestions = ['money', 'trips'] as const;

export function filterCatalog<T extends SearchableApp>(apps: readonly T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  return apps.filter(app => [
    app.name, app.description, app.category, app.detail,
    ...app.benefits, keywords[app.id] ?? '',
  ].join(' ').toLowerCase().includes(query));
}
