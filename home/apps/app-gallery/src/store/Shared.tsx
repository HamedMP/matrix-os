import React from "react";
import type { StoreCapabilities } from "../store-model";
export function Needs({
  capabilities,
}: {
  capabilities: StoreCapabilities | null;
}) {
  if (!capabilities) return <p>Capability details unavailable.</p>;
  const integrations = [
    ...capabilities.integrations.required.map((item) => ({
      ...item,
      optional: false,
    })),
    ...capabilities.integrations.optional.map((item) => ({
      ...item,
      optional: true,
    })),
  ];
  return (
    <section aria-label="What this app needs" className="store-needs">
      <h3>What this app needs</h3>
      {integrations.length ? (
        integrations.map((item) => (
          <div key={item.service}>
            <strong>{item.service}</strong>{" "}
            <small>{item.optional ? "Optional" : "Required"}</small>
            <ul>
              {item.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p>No external integrations.</p>
      )}
      <p>
        Permissions:{" "}
        {capabilities.permissions.length
          ? capabilities.permissions.join(", ")
          : "No additional permissions"}
      </p>
      {capabilities.permissions.includes("ai") && (
        <p>AI is enabled separately in your app settings.</p>
      )}
      <h4>Data stored on your computer</h4>
      {capabilities.tables.length ? (
        <ul>
          {capabilities.tables.map((table) => (
            <li key={table.name}>
              {table.name}: {table.columns.join(", ")}
            </li>
          ))}
        </ul>
      ) : (
        <p>No app data tables.</p>
      )}
      <p>Your accounts and data stay under your control.</p>
    </section>
  );
}
export function Metrics({
  value,
}: {
  value: {
    installCount: number;
    activeInstallCount?: number;
    ratingAverage: number | null;
    ratingCount: number;
  };
}) {
  return (
    <p className="store-metrics">
      <span>
        {value.ratingAverage === null
          ? "No ratings"
          : `★ ${value.ratingAverage.toFixed(1)} (${value.ratingCount})`}
      </span>
      <span>{value.installCount} downloads</span>
      {value.activeInstallCount !== undefined && (
        <span>{value.activeInstallCount} active installs</span>
      )}
    </p>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <p className="store-error" role="alert">
      {error}
    </p>
  ) : null;
}
