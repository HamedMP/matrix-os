const stamp = '2026-10-07T09:00:00.000Z';
const base = id => ({ id, created_at: stamp, updated_at: stamp });
export function defaultFixture(id, manifest) {
  const tables = Object.fromEntries(Object.keys(manifest.storage?.tables ?? {}).map(key => [key, []]));
  const kv = {};
  if (id === 'notes') tables.notes = [
    { ...base('example-note-1'), title: 'A good day in Copenhagen', content: '# A good day in Copenhagen\n\nWalk by the water before the city wakes up. Coffee, a notebook, and nowhere urgent to be.\n\n## Little things to remember\n\n- The light along the harbor\n- A bakery on the way home\n- Leave an afternoon without a plan\n\nFictional notes for this design review.', pinned: true, tags: '["Travel"]', content_json: null },
    { ...base('example-note-2'), title: 'Ideas worth keeping', content: 'Make the useful things feel simple.\n\nFictional example notes.', pinned: false, tags: '["Ideas"]', content_json: null },
  ];
  if (id === 'todo') tables.tasks = ['Book the train tickets', 'Send the design notes', 'Make room for a long walk', 'Pick up a new notebook'].map((title, i) => ({ ...base(`example-task-${i}`), title, notes: 'Fictional example task.', status: i === 3 ? 'done' : 'open', priority: i === 0 ? '3' : '1', project: i % 2 ? 'Personal' : 'Travel', due: i === 0 ? '2026-10-07T09:00:00.000Z' : null, recur: null }));
  if (id === 'calculator') tables.history = [{ ...base('example-calc-1'), expression: '128 * 3', result: '384' }, { ...base('example-calc-2'), expression: '42 / 7', result: '6' }];
  if (id === 'clock') {
    tables.zones = ['Europe/Stockholm', 'Europe/London', 'America/New_York', 'Asia/Tokyo'].map((tz, position) => ({ ...base(`example-zone-${position}`), tz, position }));
    kv['clock.seeded-v1'] = true;
  }
  if (id === 'task-manager') {
    tables.columns = ['Ideas', 'In progress', 'Review', 'Done'].map((title, position) => ({ ...base(`example-column-${position}`), title, position, color: '' }));
    tables.cards = ['Plan the autumn collection', 'Explore the app designs', 'Write the first-use guide', 'Make the little details count', 'Test the phone layouts'].map((title, i) => ({ ...base(`example-card-${i}`), title, description: 'Fictional project for design review.', column_id: `example-column-${i % 4}`, position: i, labels: JSON.stringify([i % 2 ? 'Design' : 'Product']), checklist: '[]', due: '', priority: '' }));
  }
  if (id === 'expense-tracker') {
    tables.expenses = [['Groceries', 'Saturday market', 64.8], ['Transport', 'Train to the coast', 28], ['Dining', 'Coffee with a friend', 12.5], ['Shopping', 'A new notebook', 18]].map(([category, note, amount], i) => ({ ...base(`example-expense-${i}`), category, note, amount, spent_at: `2026-10-0${i + 2}T12:00:00.000Z`, recurring: false }));
    tables.budgets = [{ ...base('example-budget'), category: 'Groceries', monthly_limit: 300 }];
  }
  if (id === 'stickies') kv['macos-stickies/notes'] = [
    { id: 'example-sticky-1', x: 28, y: 28, z: 1, color: 'yellow', text: 'Leave a little room for the unexpected.\n\nFictional example note.' },
    { id: 'example-sticky-2', x: 300, y: 92, z: 2, color: 'blue', text: 'The next trip\n\nA train, a book, a morning by the water.' },
  ];
  const fixture = { tables, kv };
  if (id === 'weather') {
    tables.locations = [{ ...base('example-location'), name: 'Copenhagen', latitude: 55.6761, longitude: 12.5683, is_default: true }];
    fixture.weather = {
      timezone: 'Europe/Copenhagen', utc_offset_seconds: 7200,
      current: { time: '2026-10-07T12:00', temperature_2m: 18, apparent_temperature: 17, weather_code: 2, is_day: 1, relative_humidity_2m: 65, wind_speed_10m: 12 },
      hourly: { time: Array.from({ length: 24 }, (_, i) => `2026-10-07T${String(i).padStart(2, '0')}:00`), temperature_2m: Array.from({ length: 24 }, (_, i) => 14 + Math.round(4 * Math.sin(i / 8))), weather_code: Array(24).fill(2) },
      daily: { time: Array.from({ length: 7 }, (_, i) => `2026-10-${String(7 + i).padStart(2, '0')}`), temperature_2m_max: [18, 19, 17, 16, 18, 20, 18], temperature_2m_min: [11, 12, 10, 10, 12, 13, 11], weather_code: [2, 1, 3, 61, 2, 0, 2], sunrise: Array.from({ length: 7 }, (_, i) => `2026-10-${String(7 + i).padStart(2, '0')}T07:20`), sunset: Array.from({ length: 7 }, (_, i) => `2026-10-${String(7 + i).padStart(2, '0')}T18:35`) },
    };
  }
  return fixture;
}
