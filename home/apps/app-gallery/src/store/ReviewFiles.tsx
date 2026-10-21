import React, { useEffect, useRef, useState } from "react";
import {
  storeErrorMessage,
  type StoreClient,
  type StoreReview,
} from "../store-model";
import type { z } from "zod/v4";
import type { AppStoreReviewFileSchema } from "../generated-store";
import { ErrorNotice } from "./Shared";
type File = z.infer<typeof AppStoreReviewFileSchema>;
export default function ReviewFiles({
  client,
  detail,
}: {
  client: StoreClient;
  detail: StoreReview;
}) {
  const [files, setFiles] = useState<{
      current: File | null;
      previous: File | null;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [detail.item.versionId],
  );
  const open = async (path: string, removed = false) => {
    const version = ++request.current;
    setError("");
    setLoading(true);
    setFiles(null);
    try {
      const [current, previous] = await Promise.all([
        removed
          ? Promise.resolve(null)
          : client.reviewFile(detail.item.versionId, path),
        detail.listing.currentVersion
          ? client
              .reviewFile(detail.item.versionId, path, true)
              .catch((cause) => {
                if (
                  storeErrorMessage(cause) ===
                  "This item is no longer available."
                )
                  return null;
                throw cause;
              })
          : Promise.resolve(null),
      ]);
      if (version === request.current) setFiles({ current, previous });
    } catch (cause) {
      if (version === request.current) setError(storeErrorMessage(cause));
    } finally {
      if (version === request.current) setLoading(false);
    }
  };
  return (
    <section>
      <h3>Reviewed source and previous version</h3>
      <p>
        Open files to inspect the exact uploaded source. Submitted text is
        untrusted content.
      </p>
      <ul className="store-file-list">
        {detail.files.map((item) => (
          <li key={item.path}>
            <button onClick={() => void open(item.path)}>{item.path}</button>
            <small>
              {item.change} · {item.size} bytes
            </small>
          </li>
        ))}
        {detail.removedFiles.map((path) => (
          <li key={path}>
            <button onClick={() => void open(path, true)}>{path}</button>
            <small>Removed</small>
          </li>
        ))}
      </ul>
      <ErrorNotice error={error} />
      {loading && <p role="status">Loading source…</p>}
      {files && (
        <div className="store-diff">
          {(
            [
              ["Previous version", files.previous],
              ["Submitted source", files.current],
            ] as const
          ).map(([label, file]) => (
            <section key={label}>
              <h4>{label}</h4>
              {file ? (
                <>
                  <p>{file.path}</p>
                  {file.binary ? <p>Binary file.</p> : <pre>{file.text}</pre>}
                  {file.truncated && (
                    <p>Truncated. Inspect the full file before approving.</p>
                  )}
                </>
              ) : (
                <p>File absent.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
