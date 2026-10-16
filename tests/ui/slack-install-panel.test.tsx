// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackInstallPanel } from '../../packages/ui/src/messaging/SlackInstallPanel';
afterEach(cleanup);
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
