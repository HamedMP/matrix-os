// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

// Use the real desktop dependency edges, including React's Editor export and
// the pinned Markdown/list extensions with the patched core/PM peers.
const desktop = createRequire(resolve('desktop/package.json'));
const { Editor }: typeof import('../../desktop/node_modules/@tiptap/react') = desktop('@tiptap/react');
const { default: StarterKit } = desktop('@tiptap/starter-kit');
const { TaskList, TaskItem } = desktop('@tiptap/extension-list');
const { Markdown } = desktop('@tiptap/markdown');
const editors: InstanceType<typeof Editor>[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

it('links the desktop React editor ESM entry used by the production bundler', () => {
  const entry = pathToFileURL(desktop.resolve('@tiptap/react').replace(/index\.cjs$/, 'index.js')).href;
  // Node checks every named ESM import. The CJS build can hide missing exports
  // in optional bubble/floating menu paths that a Markdown-only edit never uses.
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(entry)})`],
  { timeout: 10_000, stdio: 'pipe', env: {} })).not.toThrow();
});

it('edits and reopens nested checklist Markdown through the actual desktop editor libraries', () => {
  const extensions = () => [
    StarterKit.configure({ link: { openOnClick: false } }),
    TaskList, TaskItem.configure({ nested: true }), Markdown,
  ];
  const editor = new Editor({
    element: document.createElement('div'), extensions: extensions(),
    content: '# Review\n\n- [ ] Parent\n  - [ ] Child\n\nKeep **formatting**.',
    contentType: 'markdown',
  });
  editors.push(editor);
  expect(editor.getJSON()).toMatchObject({ content: [
    { type: 'heading' },
    { type: 'taskList', content: [{ type: 'taskItem', content: [
      { type: 'paragraph' },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false } }] },
    ] }] },
    { type: 'paragraph' },
  ] });
  let childPosition: number | undefined;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'paragraph' && node.textContent === 'Child') childPosition = position + 1;
  });
  expect(childPosition).toBeTypeOf('number');
  expect(editor.commands.setTextSelection(childPosition!)).toBe(true);
  expect(editor.commands.insertContent('Edited ')).toBe(true);
  const nestedCheckbox = editor.view.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
  expect(nestedCheckbox).toBeTruthy();
  nestedCheckbox.checked = true;
  nestedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
  const saved = { content_json: editor.getJSON(), content: editor.getMarkdown() };
  expect(saved.content).toContain('- [x] Edited Child');
  expect(saved.content).toContain('**formatting**');
  for (const content of [saved.content_json, saved.content]) {
    const reopened = new Editor({
      element: document.createElement('div'), extensions: extensions(), content,
      ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {}),
    });
    editors.push(reopened);
    expect(reopened.getJSON()).toEqual(saved.content_json);
    expect(reopened.getMarkdown()).toBe(saved.content);
  }
});
