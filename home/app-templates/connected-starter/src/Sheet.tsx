export default function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="backdrop" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input,textarea,select,a[href]",
              ),
            );
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button autoFocus aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
