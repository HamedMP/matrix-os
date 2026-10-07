import assert from 'node:assert/strict';
import { test } from 'node:test';
import { galleryTab, visibleCatalog } from '../src/gallery-model.ts';
import { widgetCatalog, initialWidgets, normalizeWidgets, updateWidgets, visibleWidgets } from '../src/widget-model.ts';
const apps = [
  { id: 'atlas', name: 'Atlas', category: 'Personal', description: 'Travel plans', detail: 'Flights', benefits: [], tools: ['gmail'] },
  { id: 'projects', name: 'Projects', category: 'Business', description: 'Work', detail: 'Delivery board', benefits: [], tools: ['linear'] },
  { id: 'focus', name: 'Focus', category: 'Personal', description: 'A timer', detail: 'Focus', benefits: [], tools: [] },
];
test('navigation accepts only explicit Gallery, Tools and Widgets views', () => {
  for (const tab of ['gallery', 'tools', 'widgets']) assert.equal(galleryTab(tab), tab);
  for (const tab of [null, '', 'install', 'constructor', '<script>']) assert.equal(galleryTab(tab), 'gallery');
});
test('app filtering preserves search and collection and recommends matching tools first', () => {
  assert.deepEqual(visibleCatalog(apps, 'business', [], 'trips'), []);
  assert.deepEqual(visibleCatalog(apps, 'personal', [], 'trips').map(a => a.id), ['atlas']);
  assert.deepEqual(visibleCatalog(apps, 'recommended', ['linear'], '').map(a => a.id), ['projects', 'focus', 'atlas']);
  assert.equal(visibleCatalog(apps, 'all', [], '    ').length, 3);
});
test('widget input is allowlisted, duplicate-free and capped at the finite catalog', () => {
  const dirty = [...Array(100).fill('weather'), 'constructor', '<script>', ...widgetCatalog.map(w => w.id)];
  assert.equal(normalizeWidgets(dirty).length, widgetCatalog.length);
  assert.deepEqual(normalizeWidgets({ weather: true }), []);
  assert.deepEqual(normalizeWidgets(['weather', 'weather', 'clock']), ['weather', 'clock']);
});
test('widgets add, remove and move with bounded immutable state and harmless stale actions', () => {
  const start = [...initialWidgets];
  const added = updateWidgets(start, { type: 'add', id: 'reading' });
  assert.equal(added.at(-1), 'reading');
  assert.deepEqual(start, initialWidgets);
  assert.deepEqual(updateWidgets(added, { type: 'add', id: 'reading' }), added);
  const moved = updateWidgets(added, { type: 'move', id: 'reading', direction: -1 });
  assert.equal(moved.at(-2), 'reading');
  assert.deepEqual(updateWidgets(moved, { type: 'remove', id: 'reading' }), start);
  assert.deepEqual(updateWidgets(start, { type: 'move', id: start[0], direction: -1 }), start);
  assert.deepEqual(updateWidgets(start, { type: 'add', id: 'constructor' }), start);
  assert.deepEqual(updateWidgets(start, { type: 'move', id: start[0], direction: 90 }), start);
  assert.deepEqual(updateWidgets([], { type: 'reset' }), initialWidgets);
});
test('personal and work views filter without discarding the full board', () => {
  const board = normalizeWidgets(widgetCatalog.map(w => w.id));
  const personal = visibleWidgets(board, 'personal');
  const work = visibleWidgets(board, 'business');
  assert.ok(personal.length > 0 && work.length > 0);
  assert.equal(personal.length + work.length, board.length);
  assert.equal(board.length, widgetCatalog.length);
  assert.deepEqual(visibleWidgets(['constructor'], 'all'), []);
});
test('moving a filtered widget swaps with its visible neighbor and preserves hidden widgets', () => {
  const state = ['weather', 'agenda', 'clock', 'notes'];
  assert.deepEqual(updateWidgets(state, { type: 'move', id: 'notes', direction: -1, scope: 'business' }), ['weather', 'notes', 'clock', 'agenda']);
  assert.deepEqual(updateWidgets(state, { type: 'move', id: 'agenda', direction: -1, scope: 'business' }), state);
});
