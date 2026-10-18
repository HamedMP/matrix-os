import React, { useEffect, useMemo, useState } from "react";
import type { GalleryBridge } from "./model";
import { createStoreClient, type StoreStatus } from "./store-model";
import Community from "./store/Community";
import Publish from "./store/Publish";
import Submissions from "./store/Submissions";
import Review from "./store/Review";
import "./store/store.css";
type Tab = "picks" | "community" | "publish" | "submissions" | "review";
export default function StoreHub({
  bridge,
  onActiveChange,
}: {
  bridge?: GalleryBridge;
  onActiveChange?: (active: boolean) => void;
}) {
  const client = useMemo(
    () => (bridge ? createStoreClient(bridge) : null),
    [bridge],
  );
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [tab, setTab] = useState<Tab>("picks");
  useEffect(() => {
    let active = true;
    if (client)
      void client.status().then(
        (value) => {
          if (active) setStatus(value);
        },
        () => {
          if (active) setStatus(null);
        },
      );
    return () => {
      active = false;
    };
  }, [client]);
  const choose = (value: Tab) => {
    setTab(value);
    onActiveChange?.(value !== "picks");
  };
  if (!client || !status?.enabled) return null;
  const tabs: [Tab, string][] = [
    ["picks", "Matrix picks"],
    ["community", "Community"],
    ["publish", "Publish"],
    ["submissions", "My submissions"],
    ...(status.reviewer ? [["review", "Review"] as [Tab, string]] : []),
  ];
  return (
    <section className="store-hub" aria-label="App store">
      <nav className="store-tabs" aria-label="Gallery sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => choose(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "community" && <Community client={client} />}
      {tab === "publish" && <Publish client={client} status={status} />}
      {tab === "submissions" && <Submissions client={client} />}
      {tab === "review" && status.reviewer && <Review client={client} />}
    </section>
  );
}
