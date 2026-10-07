export const reviewApps = [
  { id: 'atlas', name: 'Atlas', group: 'Gallery', idea: 'A destination canvas with your itinerary close at hand.' },
  { id: 'folio', name: 'Folio', group: 'Gallery', idea: 'A spending desk with the receipts behind every amount.' },
  { id: 'agenda', name: 'Agenda', group: 'Gallery', idea: 'Plans arranged around time.' },
  { id: 'subscriptions', name: 'Subscriptions', group: 'Gallery', idea: 'Recurring commitments, clearly separated.' },
  { id: 'focus', name: 'Focus', group: 'Gallery', idea: 'One intention and a generous, quiet timer.' },
  { id: 'meeting-briefs', name: 'Meeting Briefs', group: 'Gallery', idea: 'A document you can actually read before a meeting.' },
  { id: 'projects', name: 'Projects', group: 'Gallery', idea: 'Work organized into delivery lanes.' },
  { id: 'revenue', name: 'Revenue', group: 'Gallery', idea: 'Precise settled amounts with their underlying records.' },
  {"id": "workout-coach", "name": "Workout History Coach", "group": "Gallery", "idea": "See your progress, one working set at a time. Log sets, compare volume and keep your own training history.", "previous": false},
  {"id": "paycheck-runway", "name": "Paycheck Runway", "group": "Gallery", "idea": "Give every bill a place before the next payday. Plan confirmed income and commitments without guessing your bank balance.", "previous": false},
  {"id": "meal-planner", "name": "Meal Rotation & Grocery Plan", "group": "Gallery", "idea": "Save the recipes you like, plan portions and turn the week into one practical grocery list.", "previous": false},
  {"id": "job-search", "name": "Job Search Companion", "group": "Gallery", "idea": "A calmer place for applications, interviews and the next step. Keep confirmed updates beside your own plans.", "previous": false},
  {"id": "study-notes", "name": "Study From My Notes", "group": "Gallery", "idea": "Turn your own notes into editable, source-backed questions. Practice recall and return to what needs another look.", "previous": false},
  {"id": "journal-memory", "name": "Journal That Remembers", "group": "Gallery", "idea": "A private place to write, revisit themes and remember the decisions that mattered. You choose what is included.", "previous": false},
  {"id": "chess-coach", "name": "Chess Practice Coach", "group": "Gallery", "idea": "Revisit a completed game, inspect legal moves and practice a position using bounded local chess analysis.", "previous": false},
  {"id": "people", "name": "People", "group": "Gallery", "idea": "Remember the people, context, and next conversations that matter.", "previous": false},
  {"id": "cashflow", "name": "Cashflow", "group": "Gallery", "idea": "Track incoming invoices, due dates, and payment evidence.", "previous": false},
  { id: 'notes', name: 'Notes', group: 'Matrix defaults', idea: 'An uncluttered place to write.' },
  { id: 'todo', name: 'Todo', group: 'Matrix defaults', idea: 'A clear list with just enough structure.' },
  { id: 'task-manager', name: 'Task Manager', group: 'Matrix defaults', idea: 'A spacious board for the work ahead.' },
  { id: 'calculator', name: 'Calculator', group: 'Matrix defaults', idea: 'A tactile instrument with readable history.' },
  { id: 'clock', name: 'Clock', group: 'Matrix defaults', idea: 'Time, given room.' },
  { id: 'weather', name: 'Weather', group: 'Matrix defaults', idea: 'An atmospheric view of the day.' },
  { id: 'expense-tracker', name: 'Expense Tracker', group: 'Matrix defaults', idea: 'A personal ledger with visible budget pressure.' },
  { id: 'stickies', name: 'Stickies', group: 'Matrix defaults', idea: 'A desk for the thoughts you want to keep around.' },
  { id: 'pomodoro', name: 'Pomodoro', group: 'Matrix defaults', idea: 'A simple focus cycle, with honest session state.' },
] as const;
export type Edition = 'current' | 'original';
export type ReviewViewport = 'phone' | 'tablet' | 'desktop';
export function reviewKey(id: string, edition: Edition): string {
  if (!reviewApps.some(app => app.id === id) || !['current', 'original'].includes(edition)) throw new Error('Unknown preview app');
  const app = reviewApps.find(app => app.id === id)!;
  if (edition === 'original' && 'previous' in app && !app.previous) throw new Error('Unknown preview app');
  return `${edition}-${id}`;
}
export function reviewSize(viewport: ReviewViewport) {
  return viewport === 'phone' ? { width: 390, height: 760 }
    : viewport === 'tablet' ? { width: 768, height: 900 }
    : { width: 1200, height: 750 };
}
