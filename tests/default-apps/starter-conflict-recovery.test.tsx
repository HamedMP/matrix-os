// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import catalog from '../../home/system/app-gallery.json';
import App from '../../home/app-templates/connected-starter/src/App';
import { Editor } from '../../home/app-templates/connected-starter/src/Dialogs';
import { RecordConflictError } from '../../home/app-templates/connected-starter/src/persistence';
import type { Definition, OwnerRecord, Database } from '../../home/app-templates/connected-starter/src/types';
const app = catalog.apps.find(app => app.id === 'folio') as Definition;
const original: OwnerRecord = { id:'record', rowId:'row', fields:{title:'Original',currency:'EUR',amount:10}, scope:'personal', accounts:[],sources:[],manualFields:[],updatedAt:'2026-10-09',basePayload:{revision:1} };
const latest: OwnerRecord = {...original,fields:{...original.fields,title:'Imported title',amount:20},scope:'work',sources:[{service:'gmail',label:'Main',id:'email',title:'Receipt'}],basePayload:{revision:2}};
afterEach(() => {cleanup();delete window.MatrixOS;vi.restoreAllMocks();});
it('reviews current evidence and explicitly reapplies only owner changes without discarding the draft',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 const save=vi.fn().mockRejectedValueOnce(new RecordConflictError()).mockResolvedValueOnce(undefined),close=vi.fn(),load=vi.fn().mockResolvedValue(latest);
 render(<Editor app={app} record={original} onSave={save} onArchive={vi.fn()} onClose={close} onLoadLatest={load}/>);
 fireEvent.change(screen.getByLabelText('Title *'),{target:{value:'My unsaved title'}});
 fireEvent.click(screen.getByRole('button',{name:'Save record'}));
 await screen.findByRole('alert');
 expect(screen.getByLabelText('Title *')).toHaveProperty('value','My unsaved title');
 expect(screen.getByRole('button',{name:'Save record'})).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('button',{name:'Review latest record'}));
 await screen.findByText('Imported title');
 expect(screen.getByLabelText('Title *')).toHaveProperty('value','My unsaved title');
 expect(save).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Reapply my changes to this version'}));
 expect(screen.getByLabelText('Amount')).toHaveProperty('value','20');
 expect(screen.getByLabelText('Record group')).toHaveProperty('value','work');
 fireEvent.click(screen.getByRole('button',{name:'Save record'}));
 await waitFor(()=>expect(close).toHaveBeenCalledOnce());
 expect(save.mock.calls[1][0]).toMatchObject({fields:{title:'My unsaved title',amount:20},basePayload:{revision:2},sources:latest.sources,scope:'work'});
 expect(save.mock.calls[1][0].manualFields).toContain('title');
 expect(save.mock.calls[1][0].manualFields).not.toContain('amount');
});
it.each([null,new Error('private db details')])('preserves the draft and old guard when the current record is unavailable (%s)',async(result)=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 const save=vi.fn().mockRejectedValue(new RecordConflictError()),close=vi.fn(),load=vi.fn(async()=>{if(result instanceof Error)throw result;return result;});
 render(<Editor app={app} record={original} onSave={save} onArchive={vi.fn()} onClose={close} onLoadLatest={load}/>);
 fireEvent.change(screen.getByLabelText('Title *'),{target:{value:'Unfinished'}});
 fireEvent.click(screen.getByRole('button',{name:'Save record'})); await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Review latest record'}));
 await screen.findByText('The latest record is unavailable. Your draft is still here. Try again.');
 expect(screen.queryByRole('button',{name:'Reapply my changes to this version'})).toBeNull();
 expect(screen.getByLabelText('Title *')).toHaveProperty('value','Unfinished');
 expect(screen.getByRole('button',{name:'Save record'})).toHaveProperty('disabled',true);
 expect(close).not.toHaveBeenCalled();expect(save).toHaveBeenCalledTimes(1);
});

it('the running workspace reads the exact row for review and guards the reapplied save against that revision',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 const payload = (record:OwnerRecord) => {const {rowId,basePayload,...data}=record;return data;};
 const first=payload(original),current=payload(latest);
 const find=vi.fn().mockResolvedValue([{id:'row',payload:first}]),findOne=vi.fn().mockResolvedValue({id:'row',payload:current});
 const compareAndSwap=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true});
 window.MatrixOS={db:{find,findOne,compareAndSwap} as unknown as Database};
 render(<App app={app}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
 fireEvent.change(screen.getByLabelText('Title *'),{target:{value:'Owner draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Save record'})); await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Review latest record'})); await screen.findByText('Imported title');
 expect(findOne).toHaveBeenCalledWith('records','row');
 fireEvent.click(screen.getByRole('button',{name:'Reapply my changes to this version'}));
 fireEvent.click(screen.getByRole('button',{name:'Save record'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(compareAndSwap.mock.calls[1]).toEqual(['records','row',current,{payload:expect.objectContaining({fields:expect.objectContaining({title:'Owner draft',amount:20}),scope:'work',sources:latest.sources})}]);
});


it('recovers a new draft by its stable ID after an unacknowledged committed insert', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let stored: { id: string; payload: Record<string, unknown> } | null = null;
  const insert = vi.fn(async (_table: string, row: { id: string; payload: Record<string, unknown> }) => {
    if (!stored) stored = { id: row.id, payload: row.payload };
    throw new Error('Write acknowledgement unavailable');
  });
  const findOne = vi.fn().mockRejectedValueOnce(new Error('Read unavailable')).mockImplementation(async (_table: string, id: string) => stored?.id === id ? stored : null);
  const compareAndSwap = vi.fn().mockResolvedValue({ ok: true });
  window.MatrixOS = { db: { find: vi.fn().mockResolvedValue([]), findOne, insert, compareAndSwap } as unknown as Database };
  render(<App app={app} />);
  fireEvent.click(await screen.findByRole('button', { name: `+ Add ${app.entity}` }));
  fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'First attempt' } });
  fireEvent.change(screen.getByLabelText('Currency *'), { target: { value: 'EUR' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  await screen.findByText('Save failed. Your changes are still here.');
  fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Revised draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  await screen.findByRole('button', { name: 'Review latest record' });
  expect(screen.getByRole('button', { name: 'Save record' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Review latest record' }));
  await screen.findByText('First attempt');
  expect(findOne).toHaveBeenLastCalledWith('records', insert.mock.calls[0][1].id);
  expect(screen.getByLabelText('Title *')).toHaveProperty('value', 'Revised draft');
  fireEvent.click(screen.getByRole('button', { name: 'Reapply my changes to this version' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(insert).toHaveBeenCalledTimes(2);
  expect(compareAndSwap).toHaveBeenCalledWith('records', insert.mock.calls[0][1].id, insert.mock.calls[0][1].payload, { payload: expect.objectContaining({ fields: expect.objectContaining({ title: 'Revised draft' }) }) });
});

it('retains owner markers when an import matches the draft across repeated conflicts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const same = { ...latest, fields: { ...latest.fields, amount: 20 }, manualFields: ['currency'] };
  const later = { ...same, fields: { ...same.fields, title: 'Later imported title' }, basePayload: { revision: 3 } };
  const save = vi.fn().mockRejectedValueOnce(new RecordConflictError()).mockRejectedValueOnce(new RecordConflictError()).mockResolvedValueOnce(undefined);
  const load = vi.fn().mockResolvedValueOnce(same).mockResolvedValueOnce(later), close = vi.fn();
  render(<Editor app={app} record={original} onSave={save} onArchive={vi.fn()} onClose={close} onLoadLatest={load} />);
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '20' } });
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save record' })).toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('button', { name: 'Review latest record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reapply my changes to this version' }));
    expect(screen.getByLabelText('Amount')).toHaveProperty('value', '20');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save.mock.calls[1][0].manualFields).toEqual(expect.arrayContaining(['amount', 'currency']));
  expect(save.mock.calls[2][0].manualFields).toEqual(expect.arrayContaining(['amount', 'currency']));
  expect(save.mock.calls[2][0].manualFields).not.toContain('title');
  expect(save.mock.calls[2][0].fields.title).toBe('Later imported title');
  expect(save.mock.calls[2][0].basePayload).toEqual({ revision: 3 });
});
