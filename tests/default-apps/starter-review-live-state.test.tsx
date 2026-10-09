// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,act} from '@testing-library/react';
import catalog from '../../home/system/app-gallery.json';
import App from '../../home/app-templates/connected-starter/src/App';
import ExistingWorkflows from '../../home/app-templates/connected-starter/src/ExistingWorkflows';
import type {Definition,OwnerRecord,Database} from '../../home/app-templates/connected-starter/src/types';
const row=(id:string,amount:number,scope:'work'|'personal'='work'):OwnerRecord=>({id,fields:{title:id,status:'Sent',amount,currency:'EUR','due-date':'2024-01-01'},scope,accounts:[],sources:[],manualFields:[],updatedAt:'2026-10-09'});
const app=(id:string)=>catalog.apps.find(app=>app.id===id) as Definition;
afterEach(()=>{cleanup();delete window.MatrixOS;vi.restoreAllMocks();});
it('invoice totals use the current group while retaining an outside-filter reminder draft',()=>{
 const work=row('Work invoice',90),personal=row('Personal invoice',20,'personal'),p={app:app('cashflow'),records:[work],onSave:vi.fn(async()=>{}),onAdd:vi.fn(),onEdit:vi.fn(),onEvidence:vi.fn()};
 const view=render(<ExistingWorkflows {...p}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Reminder draft for Work invoice'}),{target:{value:'My reminder'}});
 view.rerender(<ExistingWorkflows {...p} records={[personal]}/>);
 expect(view.container.querySelector('.invoice-totals')?.textContent).toContain('€20.00');
 expect(view.container.querySelector('.invoice-totals')?.textContent).not.toContain('€90.00');
 expect(screen.getByRole('textbox',{name:'Reminder draft for Work invoice'})).toHaveProperty('value','My reminder');
 expect(screen.getByText(/draft.*outside.*filter/i)).toBeTruthy();
});
it('a paid invoice immediately leaves overdue totals without discarding its original revision draft',async()=>{
 const original=row('Invoice',90),onSave=vi.fn(async(_record:OwnerRecord)=>{}),p={app:app('cashflow'),records:[original],onSave,onAdd:vi.fn(),onEdit:vi.fn(),onEvidence:vi.fn()};
 const view=render(<ExistingWorkflows {...p}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Reminder draft for Invoice'}),{target:{value:'Draft from original revision'}});
 view.rerender(<ExistingWorkflows {...p} records={[{...original,fields:{...original.fields,status:'Paid'},updatedAt:'2026-10-10'}]}/>);
 expect(view.container.querySelector('.invoice-totals')?.textContent).not.toContain('€90.00');
 expect(screen.getByRole('textbox',{name:'Reminder draft for Invoice'})).toHaveProperty('value','Draft from original revision');
 fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(onSave).toHaveBeenCalled());
 expect(onSave.mock.calls[0][0].updatedAt).toBe(original.updatedAt);
});
it.each([['journal-memory','Today’s words'],['workout-coach','Exercise'],['study-notes','Your source passage']])('%s retains a new-entry draft while Check records refreshes an empty app',async(id,label)=>{
 let resolve!: (rows:unknown[])=>void;
 const find=vi.fn().mockResolvedValueOnce([]).mockImplementation(()=>new Promise<unknown[]>(done=>{resolve=done;}));
 window.MatrixOS={db:{find} as unknown as Database};
 render(<App app={app(id)}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Check records'})).not.toHaveProperty('disabled',true));
 fireEvent.change(screen.getByLabelText(label),{target:{value:'Unfinished owner text'}});
 fireEvent.click(screen.getByRole('button',{name:'Check records'}));
 expect(screen.getByLabelText(label)).toHaveProperty('value','Unfinished owner text');
 await act(async()=>resolve([]));
 expect(screen.getByLabelText(label)).toHaveProperty('value','Unfinished owner text');
});
