import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeReleaseNotesUrlTransform } from "../../lib/markdown";
import { invoke } from "../../lib/operator";

export default function ReleaseNotesMarkdown({ notes }: { notes: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeReleaseNotesUrlTransform}
      components={{
        img: () => null,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href?.startsWith("https://")) {
                void invoke("shell:open-external", { url: href });
              }
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {notes}
    </ReactMarkdown>
  );
}
