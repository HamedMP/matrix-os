// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackInstallPanel } from '../../packages/ui/src/messaging/SlackInstallPanel';
afterEach(cleanup);
it('sends installation through the shared Matrix entry and explains personal linking',()=>{
 const open=vi.fn();render(<SlackInstallPanel onInstall={open} />);
 expect(screen.getByRole('link',{name:'Add to Slack'}).getAttribute('href')).toBe('https://app.matrix-os.com/slack/install');
 fireEvent.click(screen.getByRole('link',{name:'Add to Slack'}));expect(open).toHaveBeenCalledOnce();
 expect(screen.getByText((_,element)=>element?.tagName==='LI' && Boolean(element.textContent?.includes('send connect')))).toBeTruthy();
 expect(screen.queryByText('Connected')).toBeNull();
});
