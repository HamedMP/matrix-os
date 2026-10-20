import React from "react";
import type { StoreDraft } from "../store-model";
import type { AppStoreDraftDiff } from "../generated-store-gateway";
export default function DraftChanges({
  draft,
  diff,
  onFile,
}: {
  draft: StoreDraft;
  diff: AppStoreDraftDiff | null;
  onFile: (path: string) => Promise<void>;
}) {
  const findings =
    draft.findingsAfter?.findings ?? draft.findingsBefore?.findings ?? [];
  const groups = [...new Set(findings.map((item) => item.category))];
  return (
    <>
      <section>
        <h4>Findings</h4>
        {groups.length ? (
          groups.map((category) => (
            <div key={category}>
              <h4>{category.replaceAll("_", " ")}</h4>
              <ul>
                {findings
                  .filter((item) => item.category === category)
                  .map((item, index) => (
                    <li key={`${item.file}:${item.line}:${index}`}>
                      <strong>{item.severity}</strong> · {item.file}
                      {item.line ? `:${item.line}` : ""} — {item.message}
                    </li>
                  ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No findings reported.</p>
        )}
        {draft.findingsAfter?.truncated && (
          <p>Findings are truncated; inspect the full source.</p>
        )}
      </section>
      <section>
        <h4>What changed</h4>
        {draft.report?.changes.length ? (
          [
            ...new Set(draft.report.changes.map((change) => change.category)),
          ].map((category) => (
            <div key={category}>
              <h4>{category}</h4>
              <ul>
                {draft
                  .report!.changes.filter(
                    (change) => change.category === category,
                  )
                  .map((change, index) => (
                    <li key={`${change.file}:${index}`}>
                      {change.file}: {change.summary}
                    </li>
                  ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No change report yet.</p>
        )}
        {draft.report?.notes && <p>{draft.report.notes}</p>}
      </section>
      <section>
        <h4>Review full source</h4>
        <p>Inspect every file, including unchanged source, before sharing.</p>
        <ul className="store-file-list">
          {(draft.sourceFiles ?? draft.changedFiles).map((item) => (
            <li key={item.path}>
              <button onClick={() => void onFile(item.path)}>
                {item.path}
              </button>
              <small>{item.change}</small>
            </li>
          ))}
        </ul>
        {diff && (
          <section aria-label={`Diff for ${diff.path}`}>
            <h4>{diff.path}</h4>
            {diff.binary ? (
              <p>Binary file; inspect it before sharing.</p>
            ) : (
              <div className="store-diff">
                <div>
                  <h4>Original</h4>
                  <pre>{diff.before ?? "(new file)"}</pre>
                </div>
                <div>
                  <h4>Shareable copy</h4>
                  <pre>{diff.after ?? "(removed file)"}</pre>
                </div>
              </div>
            )}
            {diff.truncated && (
              <p>Diff truncated. Inspect the full source before submission.</p>
            )}
          </section>
        )}
      </section>
    </>
  );
}
