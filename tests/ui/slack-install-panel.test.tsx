// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SlackInstallPanel } from '../../packages/ui/src/messaging/SlackInstallPanel';
import { AddToSlack } from '../../packages/ui/src/messaging/AddToSlack';
const sharedStyles = readFileSync(resolve(process.cwd(), 'packages/ui/src/styles.css'), 'utf8');
let stylesheet: HTMLStyleElement;
beforeEach(() => {
 stylesheet = document.createElement('style');
 stylesheet.textContent = sharedStyles;
 document.head.appendChild(stylesheet);
});
afterEach(() => { cleanup(); stylesheet.remove(); });
function interactionRules(control: HTMLElement, state: 'hover' | 'focus-visible') {
 return Array.from(stylesheet.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => {
  if (!('selectorText' in rule)) return false;
  return String(rule.selectorText).split(',').some((selector) => {
   const value = selector.trim();
   const suffix = `:${state}`;
   return value.endsWith(suffix) && control.matches(value.slice(0, -suffix.length));
  });
 });
}
it.each(['link', 'button'] as const)('connects the actual %s install control to visible enabled hover feedback', (kind) => {
 const click = vi.fn();
 render(<AddToSlack {...(kind === 'button' ? { onClick: click } : {})} />);
 const control = screen.getByRole(kind, { name: 'Add to Slack' });
 const rules = interactionRules(control, 'hover');
 expect(rules.length).toBeGreaterThan(0);
 const background = rules.map((rule) => rule.style.getPropertyValue('background')).find(Boolean);
 expect(background).toMatch(/var\(--matrix-/);
 expect(control.style.background).toBe('');
 expect(control.style.backgroundColor).toBe('');
 if (kind === 'link') expect(control.getAttribute('href')).toBe('https://app.matrix-os.com/slack/install');
 else { fireEvent.click(control); expect(click).toHaveBeenCalledOnce(); }
});
it.each(['link', 'button'] as const)('keeps the actual %s install control keyboard focusable with a visible focus ring', (kind) => {
 render(<AddToSlack {...(kind === 'button' ? { onClick: vi.fn() } : {})} />);
 const control = screen.getByRole(kind, { name: 'Add to Slack' });
 control.focus();
 expect(document.activeElement).toBe(control);
 const rules = interactionRules(control, 'focus-visible');
 expect(rules.length).toBeGreaterThan(0);
 expect(rules.some((rule) => /[1-9][0-9]*px solid var\(--matrix-/.test(rule.style.getPropertyValue('outline')))).toBe(true);
});
it.each(['disabled', 'busy', 'invalid origin'] as const)('keeps %s install controls inactive without enabled interaction styling', (state) => {
 const click = vi.fn();
 render(<AddToSlack onClick={click} disabled={state === 'disabled'} busy={state === 'busy'}
  {...(state === 'invalid origin' ? { platformOrigin: 'https://stage.example.com/path' } : {})} />);
 const control = screen.getByRole('button', { name: state === 'busy' ? 'Opening Slack…' : 'Add to Slack' });
 expect(control.hasAttribute('disabled')).toBe(true);
 expect(interactionRules(control, 'hover')).toHaveLength(0);
 expect(interactionRules(control, 'focus-visible')).toHaveLength(0);
 fireEvent.click(control);
 expect(click).not.toHaveBeenCalled();
});
it('gives the Slack connection guide visible hover and keyboard focus feedback', () => {
 render(<SlackInstallPanel />);
 const guide = screen.getByRole('link', { name: 'Slack connection guide →' });
 const hoverRules = interactionRules(guide, 'hover');
 expect(hoverRules.some((rule) => /var\(--matrix-/.test(rule.style.getPropertyValue('color')))).toBe(true);
 const focusRules = interactionRules(guide, 'focus-visible');
 expect(focusRules.some((rule) => /[1-9][0-9]*px solid var\(--matrix-/.test(rule.style.getPropertyValue('outline')))).toBe(true);
});
it('preserves a configured HTTPS operator port in the actual installation entry',()=>{
 render(<SlackInstallPanel platformOrigin="https://platform.example.com:8443" />);
 expect(screen.getByRole('link',{name:'Add to Slack'}).getAttribute('href')).toBe('https://platform.example.com:8443/slack/install');
});
it('fails closed for invalid operator config instead of opening production',()=>{
 render(<SlackInstallPanel platformOrigin="https://stage.example.com/path" />);
 expect(screen.queryByRole('link',{name:'Add to Slack'})).toBeNull();
 expect(screen.getByRole('button',{name:'Add to Slack'}).hasAttribute('disabled')).toBe(true);
});
it('preserves explicit loopback development links',()=>{
 render(<SlackInstallPanel platformOrigin="http://localhost:3000" allowDevelopmentOrigin />);
 expect(screen.getByRole('link',{name:'Add to Slack'}).getAttribute('href')).toBe('http://localhost:3000/slack/install');
});
it('keeps the configured platform authority in the installation href and external action', () => {
 const open=vi.fn();
 const configured={platformOrigin:'https://messaging-stage.example.com'};
 render(<SlackInstallPanel {...configured} onInstall={open} />);
 const link=screen.getByRole('link',{name:'Add to Slack'});
 expect(link.getAttribute('href')).toBe('https://messaging-stage.example.com/slack/install');
 fireEvent.click(link);
 expect(open).toHaveBeenCalledWith('https://messaging-stage.example.com/slack/install');
});
it('sends installation through the shared Matrix entry and explains personal linking',()=>{
 const open=vi.fn();render(<SlackInstallPanel onInstall={open} />);
 expect(screen.getByRole('link',{name:'Add to Slack'}).getAttribute('href')).toBe('https://app.matrix-os.com/slack/install');
 fireEvent.click(screen.getByRole('link',{name:'Add to Slack'}));expect(open).toHaveBeenCalledOnce();
 expect(screen.getByText((_,element)=>element?.tagName==='LI' && Boolean(element.textContent?.includes('send connect')))).toBeTruthy();
 expect(screen.queryByText('Connected')).toBeNull();
});
