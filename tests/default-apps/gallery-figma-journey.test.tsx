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
  await screen.findByText('Sent to Matrix. Follow the build in Chat.');
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
