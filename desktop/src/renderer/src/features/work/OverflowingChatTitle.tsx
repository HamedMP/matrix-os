export function OverflowingChatTitle({ title }: { title: string }) {
  return (
    <span className="min-w-0 flex-1 truncate" title={title}>
      {title}
    </span>
  );
}
