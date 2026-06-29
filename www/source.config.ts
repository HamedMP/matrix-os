import { z } from 'zod/v4';
import { applyMdxPreset, defineCollections, defineDocs, defineConfig } from 'fumadocs-mdx/config';
import lastModified from 'fumadocs-mdx/plugins/last-modified';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
      extractLinkReferences: true,
    },
    async mdxOptions(environment) {
      const [{ remarkSteps }, { remarkMdxMermaid }] = await Promise.all([
        import('fumadocs-core/mdx-plugins/remark-steps'),
        import('fumadocs-core/mdx-plugins'),
      ]);

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

export const blog = defineCollections({
  type: 'doc',
  dir: 'content/blog',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.string(),
    updatedAt: z.string().optional(),
    author: z.string().default('Matrix OS'),
    category: z.string().default('Field notes'),
    readTime: z.string(),
    keywords: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
  }),
  postprocess: {
    includeProcessedMarkdown: true,
    extractLinkReferences: true,
  },
  async mdxOptions(environment) {
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
    })(environment);
  },
});

export default defineConfig({
  plugins: [lastModified()],
});
