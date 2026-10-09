// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import catalog from '../../home/system/app-gallery.json';
import Sheet from '../../home/app-templates/connected-starter/src/Sheet';
import ExistingWorkflows from '../../home/app-templates/connected-starter/src/ExistingWorkflows';
import NewWorkflows from '../../home/app-templates/connected-starter/src/workflows/NewWorkflows';
import type {Definition,OwnerRecord} from '../../home/app-templates/connected-starter/src/types';
const row=(id:string,fields:OwnerRecord['fields']):OwnerRecord=>({id,fields,scope:'personal',accounts:[],sources:[],manualFields:[],updatedAt:'2026-10-09'});
const props=(id:string,records:OwnerRecord[])=>({app:catalog.apps.find(app=>app.id===id) as Definition,records,onSave:vi.fn(async (_record:OwnerRecord)=>{}),onAdd:vi.fn(),onEdit:vi.fn(),onEvidence:vi.fn()});
afterEach(()=>{cleanup();document.body.innerHTML='';});
it.each(['study-notes','meal-planner'])('%s exposes saved record101 and later for editing',(id)=>{
 const p=props(id,Array.from({length:125},(_,i)=>row(String(i),id==='study-notes'?{title:`Card ${i}`,question:`Question ${i}`,answer:'Answer',quote:'Answer','source-text':'Answer'}:{title:`Meal ${i}`,status:'Recipe'})));
 render(<NewWorkflows {...p}/>);
 if(id==='meal-planner')fireEvent.click(screen.getByText(/Familiar recipes/));
 fireEvent.click(screen.getByRole('button',{name:`Edit ${id==='study-notes'?'Card':'Meal'} 124`}));
 expect(p.onEdit.mock.calls[0][0].id).toBe('124');
 if(id==='meal-planner'){
  fireEvent.click(screen.getByRole('button',{name:'Preview seven-day rotation'}));
  expect(screen.getByText('Review before saving').parentElement?.querySelectorAll('p')).toHaveLength(7);
 }
});
it.each([
 ['people','Follow-up draft for Original','follow-up',{}],
 ['cashflow','Reminder draft for Original','reminder-draft',{status:'Sent',amount:50,currency:'EUR','due-date':'2024-01-01'}],
])('%s retains dirty inline text across outer filters',async(id,label,field,extra)=>{
 const original=row('original',{title:'Original',[field]:'Saved',...extra}),p=props(id,[original]);
 const view=render(<ExistingWorkflows {...p}/>);
 fireEvent.change(screen.getByRole('textbox',{name:label}),{target:{value:'Unsaved text'}});
 view.rerender(<ExistingWorkflows {...p} records={[]}/>);
 expect(screen.getByRole('textbox',{name:label})).toHaveProperty('value','Unsaved text');
 fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
 await waitFor(()=>expect(p.onSave).toHaveBeenCalled());
 expect(p.onSave.mock.calls[0][0]).toMatchObject({id:'original',fields:{[field]:'Unsaved text'}});
});
it('local invoice queues keep dirty reminders until explicit discard',()=>{
 const p=props('cashflow',[row('original',{title:'Original',status:'Sent',amount:50,currency:'EUR','due-date':'2024-01-01'})]);
 render(<ExistingWorkflows {...p}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Reminder draft for Original'}),{target:{value:'Unsaved reminder'}});
 fireEvent.change(screen.getByLabelText('Invoice queue'),{target:{value:'Settled'}});
 expect(screen.getByRole('textbox',{name:'Reminder draft for Original'})).toHaveProperty('value','Unsaved reminder');
 fireEvent.click(screen.getByRole('button',{name:'Discard draft and reload saved text'}));
 expect(screen.queryByRole('textbox',{name:'Reminder draft for Original'})).toBeNull();
});
it('Sheet restores its opener after dismissal',()=>{
 const opener=document.createElement('button');document.body.append(opener);opener.focus();
 const view=render(<Sheet title="Edit" onClose={()=>{}}><input/></Sheet>);
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Close dialog'}));
 view.unmount();expect(document.activeElement).toBe(opener);opener.remove();
});
it('Sheet restores an available fallback when its opener is removed',()=>{
 const opener=document.createElement('button'),fallback=document.createElement('button');document.body.append(opener,fallback);opener.focus();
 const view=render(<Sheet title="Edit" onClose={()=>{}}><input/></Sheet>);opener.remove();
 view.unmount();expect(document.activeElement).toBe(fallback);fallback.remove();
});
it('contact review filters keep an edited follow-up until explicit discard',()=>{
 const p=props('people',[row('original',{title:'Original',email:'person@example.com','last-contact':'2026-10-01'})]);
 render(<ExistingWorkflows {...p}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Follow-up draft for Original'}),{target:{value:'Unsaved follow-up'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Show identity or contact-date review'}));
 expect(screen.getByRole('textbox',{name:'Follow-up draft for Original'})).toHaveProperty('value','Unsaved follow-up');
 fireEvent.click(screen.getByRole('button',{name:'Discard draft and reload saved text'}));
 expect(screen.queryByRole('textbox',{name:'Follow-up draft for Original'})).toBeNull();
});
it('journal entries beyond the first100 remain editable',()=>{
 const p=props('journal-memory',Array.from({length:125},(_,i)=>row(String(i),{title:`Entry ${i}`,entry:'Owner text',kind:'Entry',date:'2026-10-09'})));
 render(<NewWorkflows {...p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Edit Entry 124'}));
 expect(p.onEdit.mock.calls[0][0].id).toBe('124');
});
