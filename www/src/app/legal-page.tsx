import type { ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";

type LegalSection = {
  title: string;
  content: ReactNode;
};

type LegalPageProps = {
  title: string;
  description: string;
  lastUpdated: string;
  sections: readonly LegalSection[];
};

export function LegalPage({ title, description, lastUpdated, sections }: LegalPageProps) {
  return (
    <div className="min-h-screen bg-[#E2E2CF] text-[#32352E]">
      <nav className="border-b border-[#D6D3C8]/80 bg-[#E2E2CF]/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-6 md:px-8">
          <a href="/" className="flex items-center gap-3 text-sm font-semibold">
            <img src="/rabbit.svg" alt="Matrix OS" className="size-7 rounded-md" />
            <span>Matrix OS</span>
          </a>
          <a href="mailto:support@matrix-os.com" className="text-sm text-[#5C5A4F] transition-colors hover:text-[#32352E]">
            support@matrix-os.com
          </a>
        </div>
      </nav>

      <main className="mx-auto max-w-[1120px] px-6 py-14 md:px-8 md:py-20">
        <a href="/" className="mb-10 inline-flex items-center gap-2 text-sm text-[#5C5A4F] transition-colors hover:text-[#32352E]">
          <ArrowLeftIcon className="size-4" />
          Back to home
        </a>

        <div className="grid gap-12 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-16">
          <aside>
            <p className="mb-4 text-sm text-[#7A7768]">Legal</p>
            <h1 className="mb-6 text-4xl font-semibold leading-tight text-[#434E3F] md:text-6xl">
              {title}
            </h1>
            <p className="text-base leading-8 text-[#5C5A4F]">{description}</p>
            <dl className="mt-10 grid gap-5 border-t border-[#D6D3C8] pt-8 text-sm">
              <div>
                <dt className="mb-1 font-medium text-[#434E3F]">Company</dt>
                <dd className="text-[#5C5A4F]">Finna Labs Inc.</dd>
              </div>
              <div>
                <dt className="mb-1 font-medium text-[#434E3F]">Contact</dt>
                <dd>
                  <a href="mailto:support@matrix-os.com" className="text-[#5C5A4F] underline decoration-[#D06F25]/50 underline-offset-4 hover:text-[#32352E]">
                    support@matrix-os.com
                  </a>
                </dd>
              </div>
              <div>
                <dt className="mb-1 font-medium text-[#434E3F]">Last updated</dt>
                <dd className="text-[#5C5A4F]">{lastUpdated}</dd>
              </div>
            </dl>
          </aside>

          <article className="divide-y divide-[#D6D3C8] border-y border-[#D6D3C8]">
            {sections.map((section) => (
              <section key={section.title} className="grid gap-5 py-9 md:grid-cols-[180px_minmax(0,1fr)] md:gap-10">
                <h2 className="text-lg font-semibold text-[#434E3F]">{section.title}</h2>
                <div className="legal-copy space-y-5 text-[15px] leading-8 text-[#4F5048]">
                  {section.content}
                </div>
              </section>
            ))}
          </article>
        </div>
      </main>
    </div>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-3 pl-5">{children}</ul>;
}
