export type ToolId = 'gmail' | 'google_calendar' | 'stripe' | 'linear';
export type Collection = 'recommended' | 'personal' | 'business' | 'all';
export interface AppInfo { id: string; name: string; category: 'Personal' | 'Business'; description: string; detail: string; tools: ToolId[]; glyph: string; benefits: string[] }
export interface DesignProps { apps: AppInfo[]; connected: ToolId[]; collection: Collection; onCollection: (collection: Collection) => void; onConnect: () => void; onPick: (app: AppInfo) => void }
