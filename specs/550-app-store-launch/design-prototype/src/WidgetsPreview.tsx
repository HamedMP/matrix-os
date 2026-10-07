import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Glyph } from './shared';
import { initialWidgets, updateWidgets, visibleWidgets, widgetCatalog, type WidgetAction, type WidgetId, type WidgetScope } from './widget-model';
import WidgetContent from './WidgetContent';
import WidgetPicker from './WidgetPicker';
import './WidgetsPreview.css';

export default function WidgetsPreview() {
  const [widgets, dispatch] = useReducer(updateWidgets, initialWidgets);
  const [scope, setScope] = useState<WidgetScope>('all');
  const [adding, setAdding] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [reset, setReset] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  // A finite catalog bounds the retained DOM references to eight cards.
  const cards = useRef<Partial<Record<WidgetId, HTMLLIElement | null>>>({});
  const pendingFocus = useRef<WidgetId | 'add' | null>(null);
  const visible = visibleWidgets(widgets, scope);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const card = target === 'add' ? null : cards.current[target];
    if (card && !card.hidden) card.focus();
    else addButton.current?.focus();
  }, [widgets, scope, adding]);

  function change(action: WidgetAction, focus: WidgetId | 'add', message: string) {
    pendingFocus.current = focus;
    dispatch(action);
    setAnnouncement(message);
  }
  function dismissPicker() {
    pendingFocus.current = 'add';
    setAdding(false);
  }

  return <main className="widgets-preview">
    <div inert={adding}>
    <header className="store-intro">
      <h1>A desktop with your kind of day.</h1>
      <p>Useful little windows into what matters.<br />Arrange a few and make the space feel yours.</p>
    </header>
    <div className="widget-board-controls">
      <nav className="gallery-collections" aria-label="Widget collection">
        {(['all', 'personal', 'business'] as const).map(value => <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{value === 'all' ? 'All widgets' : value === 'personal' ? 'Personal' : 'Work'}</button>)}
      </nav>
      <div>
        <button ref={addButton} className="quiet-button" aria-expanded={adding} aria-controls="widget-picker" onClick={() => setAdding(value => !value)}><Glyph name="grid" size={16} />Add widget</button>
        <button className="widget-reset" onClick={() => {
          dispatch({ type: 'reset' }); setReset(value => value + 1); setAdding(false); setScope('all'); setAnnouncement('Example desktop reset.');
        }}>Reset example</button>
      </div>
    </div>
    <p className="widget-demo-notice"><span />Fictional demo data · reorder with the move buttons · no owner records or live feeds</p>
    <p role="status" className="sr-only">{announcement}</p>
    <ul className="widget-board" aria-label="Example desktop widgets">{widgets.map(id => {
      const index = visible.indexOf(id);
      const widget = widgetCatalog.find(item => item.id === id)!;
      return <li key={`${id}-${reset}`} ref={element => { cards.current[id] = element; }} tabIndex={-1} aria-label={`${widget.name} widget`} hidden={index < 0} data-widget={id} className={`desktop-widget widget-${id}`}>
        <div className="widget-card-controls"><span>{widget.name}</span><div>
          <button disabled={index === 0} aria-label={`Move ${widget.name} earlier`} onClick={() => change({ type: 'move', id, direction: -1, scope }, id, `${widget.name} moved earlier.`)}>↑</button>
          <button disabled={index === visible.length - 1} aria-label={`Move ${widget.name} later`} onClick={() => change({ type: 'move', id, direction: 1, scope }, id, `${widget.name} moved later.`)}>↓</button>
          <button aria-label={`Remove ${widget.name}`} onClick={() => change({ type: 'remove', id }, visible[index + 1] ?? visible[index - 1] ?? 'add', `${widget.name} removed.`)}><Glyph name="close" size={14} /></button>
        </div></div>
        <WidgetContent id={id} />
      </li>;
    })}</ul>
    {!visible.length && <div className="store-empty"><Glyph name="grid" size={30} /><h3>A clean slate.</h3><p>Add a widget or switch the collection to see your other examples.</p><button className="quiet-button" onClick={() => setAdding(true)}>Choose a widget</button></div>}
    </div>
    {adding && <WidgetPicker widgets={widgets} onClose={dismissPicker} onAdd={id => {
      const widget = widgetCatalog.find(item => item.id === id)!;
      change({ type: 'add', id }, 'add', `${widget.name} added to the example desktop.`);
      setAdding(false);
      if (scope !== 'all' && scope !== widget.category) setScope(widget.category);
    }} />}
  </main>;
}
