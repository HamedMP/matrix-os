// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Gallery from '../../home/apps/app-gallery/src/App';
import catalog from '../../home/system/app-gallery.json';
afterEach(() => { cleanup(); delete window.MatrixOS; });
it('offers installed apps, a working build request and a returnable full app detail', async () => {
  const generate=vi.fn();
  window.MatrixOS={generate, integrations:async()=>[], gatewayFetch:async()=>({version:1,apps:catalog.apps.slice(0,3).map((app,i)=>({...app,installed:i===0, ...(i===0 ? {launchPath:`apps/${app.id}`}:{})}))})};
  render(<Gallery/>);
  await screen.findByRole('heading',{name:'Your apps'});
  fireEvent.change(screen.getByRole('textbox',{name:'Describe an app'}),{target:{value:'My weekly plan'}});
  fireEvent.click(screen.getByRole('button',{name:'Build app'}));
  expect(generate).toHaveBeenCalledTimes(1);
  await screen.findByText('Build requested. Check Chat for delivery. Your prompt is kept here.');
  expect(screen.getByRole('textbox',{name:'Describe an app'})).toHaveProperty('value','My weekly plan');
  fireEvent.click(screen.getByRole('button',{name:`Explore ${catalog.apps[0].name}`}));
  expect(await screen.findByRole('button',{name:'Back to gallery'})).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Back to gallery'}));
  expect(screen.getByRole('heading',{name:'Apps'})).toBeTruthy();
});
it('announces a failed installed-strip launch even when search hides its card', async () => {
  const app=catalog.apps[0];
  window.MatrixOS={gatewayFetch:async()=>({version:1,apps:[{...app,installed:true,launchPath:`apps/${app.id}`}]}),integrations:async()=>[],openApp:async()=>{throw new Error('unavailable');}};
  render(<Gallery/>);
  await screen.findByRole('button',{name:`Launch ${app.name}`});
  fireEvent.change(screen.getByRole('textbox',{name:'Search apps'}),{target:{value:'not present'}});
  fireEvent.click(screen.getByRole('button',{name:`Launch ${app.name}`}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','The app could not open. Try again.');
});

it.each(['Explore', 'Details for'])('returns focus to the exact %s trigger after details', async (prefix) => {
  const app=catalog.apps[0];
  window.MatrixOS={integrations:async()=>[], gatewayFetch:async()=>({version:1,apps:[{...app,installed:false}]})};
  render(<Gallery/>);
  const trigger=await screen.findByRole('button',{name:`${prefix} ${app.name}`});
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('button',{name:'Back to gallery'}));
  expect(document.activeElement).toBe(screen.getByRole('button',{name:`${prefix} ${app.name}`}));
});
it('preserves a typed request when the host rejects the build handoff', async () => {
  window.MatrixOS={generate:async()=>{throw new Error('unavailable');},integrations:async()=>[],gatewayFetch:async()=>({version:1,apps:[]})};
  render(<Gallery/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Describe an app'}),{target:{value:'Track my receipts'}});
  fireEvent.click(screen.getByRole('button',{name:'Build app'}));
  await screen.findByText('The build request could not be sent. Try again in Chat.');
  expect(screen.getByRole('textbox',{name:'Describe an app'})).toHaveProperty('value','Track my receipts');
});

it('helps a new owner find their first app from the installed-app empty state', async () => {
  window.MatrixOS={integrations:async()=>[], gatewayFetch:async()=>({version:1,apps:[]})};
  render(<Gallery/>);
  const heading=await screen.findByRole('heading',{name:'No apps yet'});
  expect(heading.closest('.installed-empty')?.querySelector('svg')).toBeTruthy();
  expect(screen.getByText('Get an app from Gallery to make it yours.')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Explore Gallery'}).getAttribute('href')).toBe('#catalog-title');
});
