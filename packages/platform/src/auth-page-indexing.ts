import { escapeHtmlAttr } from './html-escaping.js';

export function getAuthPageIndexingTags(mode: 'sign-in' | 'sign-up', appShellOrigin: string): string {
  const canonical = new URL(`/${mode}`, appShellOrigin).href;
  return `<meta name="robots" content="noindex, follow">
  <link rel="canonical" href="${escapeHtmlAttr(canonical)}">`;
}
