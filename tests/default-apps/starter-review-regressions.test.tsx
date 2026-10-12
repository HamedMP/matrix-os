// @vitest-environment jsdom
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, renderHook, act, waitFor} from '@testing-library/react';
import Sheet from '../../home/app-templates/connected-starter/src/Sheet';
import {Editor} from '../../home/app-templates/connected-starter/src/Dialogs';
import WorkspaceContent from '../../home/app-templates/connected-starter/src/WorkspaceContent';
import App from '../../home/app-templates/connected-starter/src/App';
import catalog from '../../home/system/app-gallery.json';
import type {Definition} from '../../home/app-templates/connected-starter/src/types';
const app=catalog.apps.find(a=>a.id==='subscriptions') as Definition;
afterEach(()=>{cleanup();delete window.MatrixOS;vi.restoreAllMocks();});
it('wraps focus past disabled form controls during saving',()=>{
 render(<Sheet title="Edit" onClose={()=>{}}><button>Enabled</button><input disabled/><textarea disabled/><select disabled/></Sheet>);
 const close=screen.getByRole('button',{name:'Close dialog'});close.focus();
 fireEvent.keyDown(close,{key:'Tab',shiftKey:true});
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Enabled'}));
});
it('keeps record errors visible when imports are unavailable',()=>{
 render(<WorkspaceContent app={app} records={[]} visible={[]} error="Your records could not be loaded." exportError="" loading={false} limited={false} unavailable="Import unavailable" canUseRecords onEdit={()=>{}} onEvidence={()=>{}} onAdd={()=>{}} onSave={async()=>{}}/>);
 expect(screen.getByRole('alert').textContent).toContain('Your records could not be loaded.');
});
it('new editor records inherit the active work collection',()=>{
 render(<Editor app={app} creationScope="work" onSave={async()=>{}} onArchive={async()=>{}} onClose={()=>{}}/>);
 expect(screen.getByLabelText('Record group')).toHaveProperty('value','work');
});
