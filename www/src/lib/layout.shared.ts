import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Matrix OS',
    },
    links: [
      {
        text: 'Home',
        url: '/',
      },
      {
        text: 'Whitepaper',
        url: '/whitepaper',
      },
    ],
    githubUrl: 'https://github.com/hamedmp/matrix-os',
  };
}
