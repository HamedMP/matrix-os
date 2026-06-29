"use client";

import { useEffect, useState } from "react";
import { ListTreeIcon } from "lucide-react";
import type { TOCItemType } from "fumadocs-core/toc";
import { palette as c } from "@/components/landing/theme";

function getItemId(item: TOCItemType) {
  return item.url.startsWith("#") ? item.url.slice(1) : item.url;
}

export function BlogTableOfContents({ items }: { items: TOCItemType[] }) {
  const [activeId, setActiveId] = useState(() => (items[0] ? getItemId(items[0]) : ""));

  useEffect(() => {
    const ids = items.map(getItemId);
    if (ids.length === 0) return;

    const headings = ids
      .map((id) => document.getElementById(decodeURIComponent(id)))
      .filter((heading): heading is HTMLElement => heading !== null);

    if (headings.length === 0) return;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }

        let nextActiveId = "";
        if (visible.size > 0) {
          let nearestTop = Number.POSITIVE_INFINITY;
          for (const [id, top] of visible) {
            if (top < nearestTop) {
              nextActiveId = id;
              nearestTop = top;
            }
          }
        } else {
          for (let index = headings.length - 1; index >= 0; index -= 1) {
            const heading = headings[index];
            if (heading && heading.getBoundingClientRect().top < 140) {
              nextActiveId = heading.id;
              break;
            }
          }
        }

        if (nextActiveId) {
          setActiveId((current) => (current === nextActiveId ? current : nextActiveId));
        }
      },
      {
        rootMargin: "-112px 0px -62% 0px",
        threshold: [0, 1],
      },
    );

    for (const heading of headings) {
      observer.observe(heading);
    }

    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <aside className="hidden xl:block">
      <div className="sticky top-28 rounded-2xl border bg-white/45 p-5 shadow-[0_1rem_3rem_rgba(50,53,46,0.06)]" style={{ borderColor: c.border }}>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium" style={{ color: c.deep }}>
          <ListTreeIcon className="size-4" strokeWidth={1.75} />
          On this page
        </div>
        <nav aria-label="Table of contents" className="relative flex flex-col gap-1 border-l pl-4" style={{ borderColor: c.border }}>
          {items.map((item) => {
            const id = getItemId(item);
            const active = activeId === id;

            return (
              <a
                key={item.url}
                href={item.url}
                aria-current={active ? "location" : undefined}
                className="group relative rounded-md py-1.5 text-sm leading-5 transition hover:translate-x-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2"
                style={{
                  color: active ? c.deep : c.mutedFg,
                  fontWeight: active ? 600 : 400,
                  paddingLeft: `${Math.max(item.depth - 2, 0) * 12}px`,
                  ["--tw-ring-color" as string]: c.forest,
                  ["--tw-ring-offset-color" as string]: c.pageBg,
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 -left-[1.0625rem] h-5 w-0.5 rounded-full transition-opacity"
                  style={{ backgroundColor: c.ember, opacity: active ? 1 : 0 }}
                />
                {item.title}
              </a>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
