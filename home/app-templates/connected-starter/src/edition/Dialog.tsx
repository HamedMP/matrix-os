import { useLayoutEffect, useRef, type ReactNode } from "react";
export default function Dialog({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose(): void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    // Test DOMs omit the native API; production browsers use top-layer focus trapping.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);
  return (
    <dialog
      ref={element}
      className="edition-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
