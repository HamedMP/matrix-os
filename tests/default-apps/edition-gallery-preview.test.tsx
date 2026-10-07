// @vitest-environment jsdom
import React from 'react';import {render,screen,cleanup} from '@testing-library/react';import {afterEach,it,expect} from 'vitest';
import Preview from '../../home/apps/app-gallery/src/Preview';
import catalog from '../../home/system/app-gallery.json';
afterEach(cleanup);
it('shows a screenshot of the actual Edition app with fictional reading content',()=>{render(<Preview app={catalog.apps.find(a=>a.id==='edition') as never}/>);expect(screen.getByRole('img',{name:'Edition publication library — fictional preview'}).getAttribute('src')).toBe('./edition-preview.jpg');});
