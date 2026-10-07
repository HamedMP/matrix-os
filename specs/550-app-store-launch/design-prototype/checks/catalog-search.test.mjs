import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCatalog, searchSuggestions } from '../src/catalog-search.ts';

const apps = [
  { id: 'folio', name: 'Folio', category: 'Personal', description: 'A calmer relationship with money.', detail: 'Receipts and invoices.', benefits: ['Monthly spending'] },
  { id: 'atlas', name: 'Atlas', category: 'Personal', description: 'Every journey, beautifully together.', detail: 'Booking confirmations.', benefits: ['Flights and stays'] },
  { id: 'projects', name: 'Projects', category: 'Business', description: 'See the work moving forward.', detail: 'Delivery board.', benefits: ['Milestones'] },
];

test('every empty-state suggestion finds a relevant app', () => {
  for (const query of searchSuggestions) assert.ok(filterCatalog(apps, query).length > 0, query);
  assert.deepEqual(filterCatalog(apps, 'trips').map(app => app.id), ['atlas']);
});

test('search normalizes case/whitespace and uses task details', () => {
  assert.deepEqual(filterCatalog(apps, '  ATLAS  ').map(app => app.id), ['atlas']);
  assert.deepEqual(filterCatalog(apps, 'flights').map(app => app.id), ['atlas']);
  assert.deepEqual(filterCatalog(apps, 'milestones').map(app => app.id), ['projects']);
  assert.equal(filterCatalog(apps, 'personal').length, 2);
  assert.equal(filterCatalog(apps, '   ').length, apps.length);
  assert.equal(filterCatalog(apps, 'unrelated missing query').length, 0);
});

test('search respects the collection passed by the caller', () => {
  assert.equal(filterCatalog(apps.filter(app => app.category === 'Business'), 'trips').length, 0);
});
