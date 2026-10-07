import { useEffect, useState } from 'react';
import type { WidgetId } from './widget-model';
import { Glyph } from './shared';
const coast = new URL('../public/weather-coast-demo-v1.png', import.meta.url).href;
function FocusWidget() {
  const [deadline, setDeadline] = useState<number | null>(null), [seconds, setSeconds] = useState(25 * 60);
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => { const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); setSeconds(next); if (!next) setDeadline(null); };
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [deadline]);
  return <div className="widget-focus-content"><span>One thing at a time</span><strong role="timer">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</strong><p>A moment for the work that matters.</p><button onClick={() => { if (deadline !== null) { setDeadline(null); setSeconds(1500); } else { setSeconds(1500); setDeadline(Date.now() + 1500000); } }}>{deadline === null ? 'Begin example focus' : 'Stop example focus'}</button></div>;
}
function TaskWidget() {
  const [done, setDone] = useState<string[]>([]);
  return <div className="widget-task-content"><h3>A useful next step</h3>{['Review the phone layout', 'Choose the first five apps', 'Write the launch story'].map(task => <label key={task}><input type="checkbox" checked={done.includes(task)} onChange={() => setDone(value => value.includes(task) ? value.filter(item => item !== task) : [...value, task])} /><span>{task}</span></label>)}</div>;
}
export default function WidgetContent({ id }: { id: WidgetId }) {
  switch (id) {
    case 'weather': return <div className="widget-weather-content" style={{ backgroundImage: `linear-gradient(180deg, rgb(15 40 60 / .38), rgb(15 40 60 / .48)), url(${coast})` }}><div><span>Example forecast</span><strong>18°</strong></div><h3>A little brighter outside.</h3><p>Partly cloudy · decorative coastal artwork</p><footer><span>Feels like 17°</span><span>Wind 8 km/h</span></footer></div>;
    case 'agenda': return <div className="widget-agenda-content"><span>Wednesday, October 7 · example</span><h3>A day with room to think.</h3><div><small>09:30</small><strong>Design review</strong><span>Work · 45 minutes</span></div><div><small>11:00</small><strong>Meeting preparation</strong><span>Work · 30 minutes</span></div><div><small>15:00</small><strong>A little room to build</strong><span>Work · 90 minutes</span></div></div>;
    case 'clock': return <div className="widget-clock-content"><span>Example local time</span><div><strong>09</strong><b>:</b><strong>41</strong></div><p>Wednesday, October 7</p></div>;
    case 'spending': return <div className="widget-spending-content"><span>October · example EUR spending</span><strong>€361.10</strong><div className="mini-spending-bars" role="img" aria-label="Illustrative weekly amounts: 52.1, 78, 123 and 108 euros">{[52.1, 78, 123, 108].map((amount, i) => <div key={i}><i style={{ height: amount / 123 * 90 }} /><small>Week {i + 1}</small></div>)}</div><p>Fictional amounts. No bank or email connection.</p></div>;
    case 'focus': return <FocusWidget />;
    case 'notes': return <div className="widget-note-content"><span>A thought to keep close</span><textarea aria-label="Example widget note" maxLength={1000} defaultValue={'Make something people want to come back to.\n\nStart with the useful thing.'} /><small>Temporary note · resets on reload</small></div>;
    case 'tasks': return <TaskWidget />;
    case 'reading': return <div className="widget-reading-content"><Glyph name="briefs" size={27} /><h3>Room for a good idea.</h3><article><strong>What makes a small app useful?</strong><p>Example reading note · 4 minutes</p></article><article><strong>A calmer way to plan your week</strong><p>Example reading note · 6 minutes</p></article><p>Illustrative titles, not a live news feed.</p></div>;
  }
}
