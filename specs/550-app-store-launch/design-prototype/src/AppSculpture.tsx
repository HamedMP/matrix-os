import type { CSSProperties } from 'react';
const objects = ['folio', 'atlas', 'agenda', 'subscriptions', 'focus', 'meeting-briefs', 'projects', 'revenue'];
const artwork = new URL('../public/matrix-app-objects-v1.png', import.meta.url).href;
/** Generated decorative objects, never app screenshots. Names remain outside the artwork. */
export default function AppSculpture({ id }: { id: string }) {
  const index = Math.max(0, objects.indexOf(id));
  const style = { backgroundImage: `url(${artwork})`, backgroundPosition: `${(index % 4) / 3 * 100}% ${Math.floor(index / 4) * 100}%` } as CSSProperties;
  return <span className={`sculpture-icon icon-${id}`} style={style} aria-hidden="true" />;
}
