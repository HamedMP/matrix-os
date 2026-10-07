import type { AppInfo, Collection, ToolId } from './types';
import { filterCatalog } from './catalog-search.ts';
export type GalleryTab = 'gallery' | 'tools' | 'widgets';
export function galleryTab(value: unknown): GalleryTab {
  return value === 'tools' || value === 'widgets' ? value : 'gallery';
}
export function visibleCatalog<T extends AppInfo>(apps: T[], collection: Collection, connected: ToolId[], search: string): T[] {
  const filtered = apps.filter(app => collection === 'personal' ? app.category === 'Personal' : collection === 'business' ? app.category === 'Business' : true);
  return filterCatalog(filtered, search).toSorted((a, b) => collection === 'recommended'
    ? Number(b.tools.every(id => connected.includes(id))) - Number(a.tools.every(id => connected.includes(id))) : 0);
}
