// Fictional inputs for the actual workflow components. No accounts or imports are simulated.
const stamp = '2026-10-07T09:00:00.000Z';
const fixtureFields = {
  'workout-coach': [
    { title: 'Squat · warmup', date: '2026-10-07', exercise: 'Squat', weight: 20, unit: 'kg', reps: 10, 'set-type': 'Warmup' },
    { title: 'Squat · working set', date: '2026-10-07', exercise: 'Squat', weight: 60, unit: 'kg', reps: 5, 'set-type': 'Working' },
    { title: 'Squat · working set', date: '2026-10-07', exercise: 'Squat', weight: 60, unit: 'kg', reps: 5, 'set-type': 'Working' },
    { title: 'Squat · earlier session', date: '2026-10-02', exercise: 'Squat', weight: 55, unit: 'kg', reps: 5, 'set-type': 'Working' },
    { title: 'Squat · first session', date: '2026-09-28', exercise: 'Squat', weight: 110, unit: 'lb', reps: 5, 'set-type': 'Working' },
    { title: 'Bench press', date: '2026-10-07', exercise: 'Bench press', weight: 40, unit: 'kg', reps: 8, 'set-type': 'Working' },
  ],
  'paycheck-runway': [
    { title: 'Cash available today', date: '2026-10-07', kind: 'Opening balance', amount: 1050, currency: 'EUR', status: 'Confirmed' },
    { title: 'Electricity · still unpaid', date: '2026-10-05', kind: 'Bill', amount: 64, currency: 'EUR', status: 'Confirmed' },
    { title: 'Rent', date: '2026-10-09', kind: 'Bill', amount: 700, currency: 'EUR', status: 'Confirmed' },
    { title: 'Train pass', date: '2026-10-12', kind: 'Bill', amount: 98, currency: 'EUR', status: 'Confirmed' },
    { title: 'Groceries reserve', date: '2026-10-14', kind: 'Reserve', amount: 120, currency: 'EUR', status: 'Confirmed' },
    { title: 'Next paycheck · future cash', date: '2026-10-21', kind: 'Income', amount: 2400, currency: 'EUR', status: 'Estimate' },
  ],
  'meal-planner': [
    { title: 'Lemon rice bowl', status: 'Recipe', servings: 2, ingredients: 'rice | 200 | g\nchickpeas | 240 | g\nlemon | 1 | each', notes: 'A familiar fictional recipe.' },
    { title: 'Tomato pasta', status: 'Recipe', servings: 2, ingredients: 'pasta | 200 | g\ntomato | 300 | g\nolive oil | 20 | ml' },
    { title: 'Lemon rice bowl', status: 'Planned', date: '2026-10-07', servings: 2, 'planned-portions': 4, ingredients: 'rice | 200 | g\nchickpeas | 240 | g\nlemon | 1 | each', pantry: 'rice | 100 | g' },
    { title: 'Tomato pasta', status: 'Planned', date: '2026-10-08', servings: 2, 'planned-portions': 2, ingredients: 'pasta | 200 | g\ntomato | 300 | g\nolive oil | 20 | ml' },
    { title: 'Lemon rice bowl', status: 'Planned', date: '2026-10-09', servings: 2, 'planned-portions': 2, ingredients: 'rice | 0.2 | kg\nchickpeas | 240 | g\nlemon | 1 | each' },
  ],
  'job-search': [
    { title: 'Product designer', company: 'Northwind Studio', date: '2026-10-03', stage: 'Interview', certainty: 'Confirmed', 'interview-date': '2026-10-08', 'interview-time': '10:30', timezone: 'Europe/Stockholm', resume: 'Fictional résumé notes: three years designing useful consumer tools; led an accessible onboarding redesign.', 'next-step': 'Prepare one project story and questions about the team.' },
    { title: 'Design engineer', company: 'Coastal Tools', date: '2026-10-05', stage: 'Applied', certainty: 'Confirmed', 'next-step': 'Wait for the employer reply; keep the submitted portfolio notes.' },
    { title: 'UX researcher', company: 'Juniper Collective', stage: 'Saved', certainty: 'Estimate', 'next-step': 'Review the role and decide whether to apply.' },
  ],
  'study-notes': [
    { title: 'Cell biology · energy', date: '2026-10-07', 'source-text': 'Mitochondria produce ATP. Chloroplasts perform photosynthesis.', question: 'Which organelle produces ATP?', answer: 'Mitochondria', quote: 'Mitochondria produce ATP.', practice: 'New' },
    { title: 'Cell biology · plants', date: '2026-10-07', 'source-text': 'Mitochondria produce ATP. Chloroplasts perform photosynthesis.', question: 'Which organelle performs photosynthesis?', answer: 'Chloroplasts', quote: 'Chloroplasts perform photosynthesis.', practice: 'Again' },
    { title: 'Design notes · source passage', date: '2026-10-06', 'source-text': 'Clear labels help people understand an action. Consistent feedback helps people know what changed. Readable text supports comfortable use.' },
  ],
  'journal-memory': [
    { title: 'A long walk by the harbor', date: '2026-10-07', entry: 'Walked by the water with Ada after work. We talked about making more room for weekends without a schedule.', tags: 'walking, Ada, time', include: 'Include', kind: 'Entry' },
    { title: 'Room to make something', date: '2026-10-05', entry: 'An afternoon with a notebook and no meetings. Sketched an idea for a small app that makes daily planning feel lighter.', tags: 'time, ideas', include: 'Include', kind: 'Entry' },
    { title: 'Dinner with Ada', date: '2026-10-03', entry: 'Cooked a familiar recipe and caught up with Ada. The slow evening was the part I wanted to remember.', tags: 'Ada, cooking', include: 'Include', kind: 'Entry' },
    { title: 'An entry kept out of reflections', date: '2026-10-04', entry: 'Fictional private note. This entry is excluded from digest and model requests.', include: 'Exclude', kind: 'Entry' },
  ],
  'chess-coach': [
    { title: 'A finished game · White', date: '2026-10-06', status: 'Completed', perspective: 'White', pgn: '[Event "Fictional completed teaching game"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0', notes: 'A legal completed illustrative game. Local analysis requires the installed app worker; this offline preview blocks workers.' },
    { title: 'A short completed draw', date: '2026-10-04', status: 'Completed', perspective: 'Black', pgn: '[Event "Fictional agreed draw"]\n[Result "1/2-1/2"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 1/2-1/2', notes: 'Fictional agreed draw. No engine evaluation has been fabricated.' },
  ],
  people: [
    { title: 'Ada Chen', company: 'Northwind Studio', email: 'ada@example.test', date: '2026-10-07', context: 'Met at a fictional design workshop. Enjoys thoughtful product conversations.', 'last-contact': '2026-09-21', 'next-contact': '2026-10-09', notes: 'Ask how the autumn project is going.' },
    { title: 'Leo Martins', company: 'Coastal Tools', email: 'leo@example.test', date: '2026-10-05', context: 'A fictional former teammate. We trade book recommendations.', 'last-contact': '2026-09-05', 'next-contact': '2026-10-12' },
    { title: 'Mira Sol', company: 'Juniper Collective', email: 'mira@example.test', date: '2026-10-06', context: 'A fictional friend from the neighborhood.', 'last-contact': '2026-10-01', notes: 'Remember the coffee place near the station.' },
  ],
  cashflow: [
    { title: 'Design workshop', client: 'Northwind Studio', amount: 1200, currency: 'EUR', date: '2026-09-22', 'due-date': '2026-10-02', status: 'Sent', email: 'accounts@example.test' },
    { title: 'Product consultation', client: 'Coastal Tools', amount: 800, 'paid-amount': 300, currency: 'EUR', date: '2026-09-28', 'due-date': '2026-10-12', status: 'Partial', email: 'finance@example.test' },
    { title: 'Research sprint', client: 'Juniper Collective', amount: 650, currency: 'USD', date: '2026-09-29', 'due-date': '2026-10-15', status: 'Sent' },
    { title: 'Completed studio session', client: 'Willow House', amount: 450, 'paid-amount': 450, currency: 'EUR', date: '2026-09-10', 'due-date': '2026-09-25', status: 'Paid' },
  ],
};

export function workflowFixture(id, definition) {
  const fields = fixtureFields[id];
  if (!fields) throw Error('Unknown fictional workflow fixture');
  const appIndex = Object.keys(fixtureFields).indexOf(id) + 1;
  const allowed = new Set(definition.fields.map(field => field.key));
  return fields.map((values, index) => {
    if (Object.keys(values).some(key => !allowed.has(key))) throw Error('Fictional fixture has an unknown schema field');
    for (const field of definition.fields) {
      if (field.required && (values[field.key] === undefined || values[field.key] === null)) throw Error('Fictional fixture omits a required field');
      if (values[field.key] !== undefined && field.kind === 'select' && !field.options.includes(values[field.key])) throw Error('Fictional fixture uses an invalid selection');
    }
    const recordId = `10000000-0000-4000-8000-${String(appIndex * 1000 + index).padStart(12, '0')}`;
    return { id: recordId, source_id: `fictional:${id}:${index}`, created_at: stamp, payload: { id: recordId, fields: values, scope: id === 'cashflow' ? 'work' : 'personal', accounts: [], sources: [], manualFields: Object.keys(values), updatedAt: stamp } };
  });
}
