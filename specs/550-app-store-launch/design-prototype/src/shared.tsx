import type { AppInfo, ToolId } from './types';
import { BookOpen, CalendarDays, Check, ChevronRight, CircleDollarSign, Clock3, CreditCard, FileText, Focus, Grid2X2, Layers3, Link2, Mail, MapPin, Search, ShieldCheck, Smartphone, Sparkles, Star, X } from 'lucide-react';

export const tools: { id: ToolId; name: string; description: string }[] = [
  { id: 'gmail', name: 'Gmail', description: 'Receipts, bookings and useful context' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'Your days, plans and meetings' },
  { id: 'stripe', name: 'Stripe', description: 'Payments and invoices' },
  { id: 'linear', name: 'Linear', description: 'Projects, milestones and issues' },
];

export const apps: AppInfo[] = [
  { id: 'folio', name: 'Folio', category: 'Personal', description: 'A calmer relationship with money.', detail: 'Your receipts and invoices become a clear picture of spending. Explore a month, check a receipt, and keep work and personal costs in view.', tools: ['gmail'], glyph: 'folio', benefits: ['Weekly and monthly spending', 'Receipts with source evidence', 'Separate work and personal'] },
  { id: 'atlas', name: 'Atlas', category: 'Personal', description: 'Every journey, beautifully together.', detail: 'Bring booking confirmations and calendar plans into one place. Explore destinations and find the details you need for your next journey.', tools: ['gmail', 'google_calendar'], glyph: 'atlas', benefits: ['Your journeys in one place', 'Flights, stays and plans', 'Source-backed trip details'] },
  { id: 'agenda', name: 'Agenda', category: 'Personal', description: 'A little more room in your day.', detail: 'A readable timeline for today and the week ahead, with the next thing you need to know always within reach.', tools: ['google_calendar'], glyph: 'agenda', benefits: ['A clear day timeline', 'Week navigation', 'Event details and locations'] },
  { id: 'subscriptions', name: 'Subscriptions', category: 'Personal', description: 'Know what keeps coming around.', detail: 'Review recurring costs with their billing evidence. Confirm what repeats and keep the next evidenced renewal in view.', tools: ['gmail'], glyph: 'subscriptions', benefits: ['Recurring costs by currency', 'Billing evidence', 'Confirmed and inferred recurrence'] },
  { id: 'focus', name: 'Focus', category: 'Personal', description: 'One thing. Your full attention.', detail: 'Choose an intention, start a calm timer and keep a record of the time you gave to something that matters.', tools: [], glyph: 'focus', benefits: ['A purposeful focus timer', 'Session journal', 'No connection needed'] },
  { id: 'meeting-briefs', name: 'Meeting Briefs', category: 'Business', description: 'Walk in with the useful context.', detail: 'Prepare for your next meeting with the relevant conversation, attendees and your own notes collected into a readable brief.', tools: ['gmail', 'google_calendar'], glyph: 'briefs', benefits: ['Meeting preparation', 'Source-supported context', 'Your action notes'] },
  { id: 'projects', name: 'Projects', category: 'Business', description: 'See the work moving forward.', detail: 'Bring projects, milestones and issues into a view built for understanding what is moving and what needs attention.', tools: ['linear'], glyph: 'projects', benefits: ['Project milestones', 'Issue lanes and filters', 'Original issue references'] },
  { id: 'revenue', name: 'Revenue', category: 'Business', description: 'A clear view of money coming in.', detail: 'Review settled payments and invoices, keep currencies separate and inspect the evidence behind each number.', tools: ['stripe'], glyph: 'revenue', benefits: ['Settled revenue by currency', 'Invoice and payment review', 'Reconciliation details'] },
];

const glyphs = { folio: FileText, atlas: MapPin, agenda: CalendarDays, subscriptions: Clock3, focus: Focus, briefs: BookOpen, projects: Layers3, revenue: CircleDollarSign, search: Search, arrow: ChevronRight, check: Check, close: X, grid: Grid2X2, link: Link2, phone: Smartphone, shield: ShieldCheck, sparkles: Sparkles, star: Star, gmail: Mail, google_calendar: CalendarDays, stripe: CreditCard, linear: Layers3 };
export function Glyph({ name, size = 22 }: { name: string; size?: number }) { const Icon = glyphs[name as keyof typeof glyphs] ?? Grid2X2; return <Icon size={size} strokeWidth={1.7} aria-hidden="true" />; }
export function ToolName({ id }: { id: ToolId }) { return <span className="tool-name"><Glyph name={id} size={16} />{tools.find(tool => tool.id === id)?.name}</span>; }
export function reason(app: AppInfo, connected: ToolId[]) {
  if (!app.tools.length) return 'No connection needed';
  const missing = app.tools.filter(id => !connected.includes(id));
  if (!missing.length) return `Works with your ${app.tools.map(id => tools.find(tool => tool.id === id)?.name).join(' and ')}`;
  return `Connect ${missing.map(id => tools.find(tool => tool.id === id)?.name).join(' and ')}`;
}
export function AppCard({ app, connected, onPick, compact = false }: { app: AppInfo; connected: ToolId[]; onPick: (app: AppInfo) => void; compact?: boolean }) {
  return <button className={`app-card ${compact ? 'compact' : ''}`} onClick={() => onPick(app)} aria-label={`Explore ${app.name}`}>
    <div className="app-shot"><img src={`./previews/${app.id}.webp`} width="1200" height="750" alt={`${app.name} actual starter interface with fictional example records`} loading="lazy" /><span>Example data</span></div>
    <div className="app-card-body"><div className={`app-glyph glyph-${app.id}`}><Glyph name={app.glyph} /></div><div className="app-name-block"><h3>{app.name}</h3><p>{app.description}</p></div><Glyph name="arrow" size={18} /></div>
    <div className="app-card-foot"><span>{reason(app, connected)}</span><span>Free</span></div>
  </button>;
}
