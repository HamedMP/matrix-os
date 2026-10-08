export function BotBindingStatus({ loading, retry }: { loading:boolean; retry():void }) {
  return <div role={loading ? "status" : "alert"} className="mx-auto my-3 flex max-w-[720px] items-center gap-3 px-4 text-sm">
    <span>{loading ? "Loading Chat identity…" : "Chat identity could not be loaded. Try again."}</span>
    {!loading ? <button type="button" onClick={retry} className="rounded-lg border px-3 py-1">Retry</button> : null}
  </div>;
}
