import { describe, expect, it } from 'vitest';
import { addViewerLocation } from '../../scripts/spikes/browser-vps/nginx-viewer.mjs';
describe('test browser stream proxy installation', () => {
  it.each(['  ', '        '])('supports deployed indentation %j and remains idempotent', indent => {
    const before = `server {\n${indent}location /apps/ {\n${indent}  proxy_pass http://127.0.0.1:4000;\n${indent}}\n}`;
    const after = addViewerLocation(before);
    expect(after).toContain('location = /apps/browser-lab/viewer/websockify');
    expect(after).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(addViewerLocation(after)).toBe(after);
  });
  it('refuses ambiguous or missing app proxy anchors', () => {
    expect(() => addViewerLocation('server {}')).toThrow();
    expect(() => addViewerLocation('  location /apps/ {\n  location /apps/ {')).toThrow();
  });
});
