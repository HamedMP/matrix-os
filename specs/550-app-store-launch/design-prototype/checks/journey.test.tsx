import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('../src/DemoFrame',()=>({default:({id}:{id:string})=>createElement('div',{'data-testid':'source-preview'},id)}));
import Journey from '../src/Journey';
afterEach(cleanup);
describe('launch journey walkthrough',()=>{
 it('makes discovery locations and production status explicit',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  expect(screen.getByText('Design simulation · fictional data · no installation or account access')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Web Desktop'}));
  expect(screen.getByText('Launcher → App Gallery')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Native Mobile'}));
  expect(screen.getByText('Apps → Explore apps')).toBeTruthy();
  expect(screen.getByText(/Native Mobile needs qualification/)).toBeTruthy();
 });
 it('separates installation, account consent and import completion',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/4\. Preview & install/}));
  fireEvent.click(screen.getByRole('button',{name:'Install Folio'}));
  expect(screen.getByText('Folio is ready. Your app starts empty.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/5\. Choose data/}));
  const start=screen.getByRole('button',{name:'Import receipts'});
  expect(start.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/^Personal Gmail/}));
  fireEvent.click(start);
  expect(screen.getByText('Import requested')).toBeTruthy();
  expect(screen.queryByText('12 receipts saved')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show completed scenario'}));
  expect(screen.getByText('12 receipts saved')).toBeTruthy();
 });
 it('keeps a failed chat save draft and uses one fictional row on retry',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/7\. Add data from chat/}));
  fireEvent.click(screen.getByRole('button',{name:'Review expense'}));
  fireEvent.click(screen.getByLabelText('Simulate a failed save'));
  fireEvent.click(screen.getByRole('button',{name:'Add to Folio'}));
  expect(screen.getByRole('alert').textContent).toContain('Your expense was not saved');
  expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('Corner Café');
  fireEvent.click(screen.getByLabelText('Simulate a failed save'));
  fireEvent.click(screen.getByRole('button',{name:'Add to Folio'}));
  expect(screen.getByText('Saved to Folio')).toBeTruthy();
  expect(screen.getByText('Chat · Work')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Open record'}));
  expect(screen.getByText('1 chat expense')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/7\. Add data from chat/}));
  expect(screen.queryByRole('button',{name:'Add to Folio'})).toBeNull();
 });
 it('clears the completed import when its date range changes',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/4\. Preview & install/}));
  fireEvent.click(screen.getByRole('button',{name:'Install Folio'}));
  fireEvent.click(screen.getByRole('button',{name:/5\. Choose data/}));
  fireEvent.click(screen.getByRole('checkbox',{name:/^Personal Gmail/}));
  fireEvent.click(screen.getByRole('button',{name:'Import receipts'}));
  fireEvent.click(screen.getByRole('button',{name:'Show completed scenario'}));
  expect(screen.getByText('12 receipts saved')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Date range'),{target:{value:'This month'}});
  expect(screen.queryByText('12 receipts saved')).toBeNull();
  expect(screen.queryByRole('button',{name:'Open saved results'})).toBeNull();
  expect(screen.getByRole('button',{name:'Import receipts'}).hasAttribute('disabled')).toBe(false);
 });
 it('shows an existing app before the explicit custom-build branch',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/6\. Apps in chat/}));
  expect(screen.getByText('Folio already does this.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Build something different'}));
  expect(screen.getByText('Review your app brief')).toBeTruthy();
  expect(screen.getByText(/Write permissions require a separate choice/)).toBeTruthy();
 });
 it('keeps Atlas and Focus installs in their own setup contexts',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/3\. Find your apps/}));
  fireEvent.click(screen.getByRole('button',{name:/^Atlas/}));
  fireEvent.click(screen.getByRole('button',{name:'Install Atlas'}));
  fireEvent.click(screen.getByRole('button',{name:'Open Atlas'}));
  expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('Full 2026 year');
  expect(screen.getByRole('button',{name:'Import trips'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/3\. Find your apps/}));
  fireEvent.click(screen.getByRole('button',{name:/^Focus/}));
  fireEvent.click(screen.getByRole('button',{name:'Install Focus'}));
  fireEvent.click(screen.getByRole('button',{name:'Open Focus'}));
  expect(screen.queryByRole('checkbox',{name:/^Personal Gmail/})).toBeNull();
  expect(screen.getByRole('button',{name:'Start a focus session'})).toBeTruthy();
 });

 it('does not reuse an Atlas import when entering the isolated Folio chat scenario',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/3\. Find your apps/}));
  fireEvent.click(screen.getByRole('button',{name:/^Atlas/}));
  fireEvent.click(screen.getByRole('button',{name:'Install Atlas'}));
  fireEvent.click(screen.getByRole('button',{name:'Open Atlas'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/^Personal Gmail/}));
  fireEvent.click(screen.getByRole('button',{name:'Import trips'}));
  fireEvent.click(screen.getByRole('button',{name:'Show completed scenario'}));
  fireEvent.click(screen.getByRole('button',{name:/7\. Add data from chat/}));
  fireEvent.click(screen.getByRole('button',{name:/5\. Choose data/}));
  expect(screen.queryByText('12 receipts saved')).toBeNull();
  expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('Last 3 months');
  expect((screen.getByRole('checkbox',{name:/^Personal Gmail/}) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('button',{name:'Import receipts'}).hasAttribute('disabled')).toBe(true);
 });
 it('opens the app named by the custom preview and keeps daily-use copy consistent',()=>{
  render(createElement(Journey,{onClose:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:/3\. Find your apps/}));
  fireEvent.click(screen.getByRole('button',{name:/^Atlas/}));
  fireEvent.click(screen.getByRole('button',{name:/8\. Use it everywhere/}));
  expect(screen.getByText('How is Atlas working for you?')).toBeTruthy();
  expect(screen.getByRole('checkbox',{name:/Trip reminders/})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/6\. Apps in chat/}));
  fireEvent.click(screen.getByRole('button',{name:'Build something different'}));
  fireEvent.click(screen.getByRole('button',{name:'Build this example'}));
  fireEvent.click(screen.getByRole('button',{name:'Review app preview'}));
  expect(screen.getByRole('button',{name:'Install Folio'})).toBeTruthy();
 });

});
