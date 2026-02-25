import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Matrix OS',
    },
    links: [
      {
        text: 'Whitepaper',
        url: '/whitepaper',
      },
      {
        text: 'DeepWiki',
        url: 'https://deepwiki.com/HamedMP/matrix-os/',
        external: true,
      },
    ],
    githubUrl: 'https://github.com/hamedmp/matrix-os',
  };
}
