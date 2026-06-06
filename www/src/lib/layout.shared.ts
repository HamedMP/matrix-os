import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Matrix OS',
    },
    links: [
      {
        text: 'Docs Home',
        url: '/docs',
      },
      {
        text: 'Whitepaper',
        url: '/whitepaper',
      },
    ],
  };
}
