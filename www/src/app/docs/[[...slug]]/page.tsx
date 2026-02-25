import {
  DocsPage,
  DocsTitle,
  DocsDescription,
  DocsBody,
} from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Mermaid } from '@/components/mdx/mermaid';
import { source, getPageImage } from '@/lib/source';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Feedback } from '@/components/feedback/client';
import { LLMCopyButton, ViewOptions } from '@/components/page-actions';
import type { PageFeedback } from '@/components/feedback/schema';

async function onFeedback(feedback: PageFeedback) {
  'use server';
  console.log(
    '[docs-feedback]',
    feedback.opinion,
    feedback.url,
    feedback.message,
  );
  return {};
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);

  if (!page) notFound();

  const Mdx = page.data.body;

  return (
    <DocsPage toc={page.data.toc} tableOfContent={{ style: 'clerk' }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className='flex flex-row gap-2 items-center border-b pt-2 pb-6'>
        <LLMCopyButton markdownUrl={`${page.url}.mdx`} />
        <ViewOptions
          markdownUrl={`${page.url}.mdx`}
          githubUrl={`https://github.com/hamedmp/matrix-os/blob/main/www/content/docs/${page.slugs.join('/')}.mdx`}
        />
      </div>
      <DocsBody>
        <Mdx components={{ ...defaultMdxComponents, Mermaid }} />
      </DocsBody>
      <Feedback onSendAction={onFeedback} />
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);

  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
