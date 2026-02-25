import { applyMdxPreset, defineDocs, defineConfig } from 'fumadocs-mdx/config';
import lastModified from 'fumadocs-mdx/plugins/last-modified';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
      extractLinkReferences: true,
    },
    async mdxOptions(environment) {
      const { remarkSteps } = await import('fumadocs-core/mdx-plugins/remark-steps');
      const { remarkMdxMermaid } = await import('fumadocs-core/mdx-plugins');

      return applyMdxPreset({
        rehypeCodeOptions: {
          themes: {
            light: 'catppuccin-latte',
            dark: 'catppuccin-mocha',
          },
        },
        remarkCodeTabOptions: {
          parseMdx: true,
        },
        remarkNpmOptions: {
          persist: { id: 'package-manager' },
        },
        remarkStructureOptions: {
          stringify: {
            filterElement(node) {
              switch (node.type) {
                case 'mdxJsxFlowElement':
                case 'mdxJsxTextElement':
                  switch (node.name) {
                    case 'Callout':
                    case 'Card':
                      return true;
                  }
                  return 'children-only';
              }
              return true;
            },
          },
        },
        remarkPlugins: [remarkSteps, remarkMdxMermaid],
      })(environment);
    },
  },
});

export default defineConfig({
  plugins: [lastModified()],
});
