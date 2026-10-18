// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Review from "../../home/apps/app-gallery/src/store/Review";
import Submissions from "../../home/apps/app-gallery/src/store/Submissions";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { id, secondId, summary } from "./app-store-fixtures";
afterEach(cleanup);
it("keeps published and hidden listings reachable for staff moderation", async () => {
  let status = "live";
  const { local, ...listing } = summary();
  const gatewayFetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes("/review/queue")) return { items: [] };
    if (url.endsWith("/action")) {
      status = JSON.parse(init!.body!).type === "delist" ? "delisted" : "live";
      return { ...listing, status };
    }
    return { listings: [{ ...listing, status }] };
  });
  render(
    <Review client={createStoreClient({ gatewayFetch, openApp: vi.fn() })} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Published listings" }),
  );
  await screen.findByRole("heading", { name: "Sample Notes" });
  fireEvent.click(screen.getByRole("button", { name: "Delist Sample Notes" }));
  expect(
    (
      screen.getByRole("button", {
        name: "Confirm delist",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Moderation message"), {
    target: { value: "Temporarily remove from discovery" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm delist" }));
  await screen.findByRole("button", { name: "Reinstate Sample Notes" });
  fireEvent.click(screen.getByRole("button", { name: "Back to review queue" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Published listings" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reinstate Sample Notes" }),
  );
  fireEvent.change(screen.getByLabelText("Moderation message"), {
    target: { value: "Issue corrected" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm reinstate" }));
  await screen.findByRole("button", { name: "Delist Sample Notes" });
  expect(
    gatewayFetch.mock.calls.filter(([url]) => url.endsWith("/action")),
  ).toHaveLength(2);
});
it("merges publisher listings as well as submissions when paging", async () => {
  const metrics = {
    installCount: 1,
    activeInstallCount: 1,
    ratingAverage: null,
    ratingCount: 0,
  };
  const gatewayFetch = vi.fn(async (url: string) =>
    url.includes("cursor=")
      ? {
          listings: [
            {
              id: secondId,
              slug: "second-notes",
              name: "Second Notes",
              status: "live",
              currentVersion: "1.0.0",
              ...metrics,
            },
          ],
          submissions: [],
        }
      : {
          listings: [
            {
              id,
              slug: "sample-notes",
              name: "Sample Notes",
              status: "live",
              currentVersion: "1.0.0",
              ...metrics,
            },
          ],
          submissions: [],
          nextCursor: "next",
        },
  );
  render(
    <Submissions
      client={createStoreClient({ gatewayFetch, openApp: vi.fn() })}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more submissions" }),
  );
  await screen.findByRole("heading", { name: "Second Notes" });
  expect(screen.getByRole("heading", { name: "Sample Notes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh submissions" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Second Notes" })).toBeNull(),
  );
});

it("pages published listings and keeps a safe message when moderation fails", async () => {
  const { local, ...listing } = summary();
  const gatewayFetch = vi.fn(async (url: string) => {
    if (url.includes("/review/queue")) return { items: [] };
    if (url.endsWith("/action"))
      throw new Error("postgres://secret@internal/private");
    if (url.includes("cursor="))
      return {
        listings: [
          {
            ...listing,
            id: secondId,
            slug: "second-notes",
            name: "Second Notes",
            status: "suspended",
          },
        ],
      };
    return { listings: [listing], nextCursor: "next" };
  });
  render(
    <Review client={createStoreClient({ gatewayFetch, openApp: vi.fn() })} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Published listings" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more published listings" }),
  );
  await screen.findByRole("heading", { name: "Second Notes" });
  expect(screen.getByRole("heading", { name: "Sample Notes" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Reinstate Second Notes" }),
  );
  fireEvent.change(screen.getByLabelText("Moderation message"), {
    target: { value: "Issue corrected" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm reinstate" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "This action could not finish. Try again.",
  );
  expect(
    (screen.getByLabelText("Moderation message") as HTMLTextAreaElement).value,
  ).toBe("Issue corrected");
  expect(screen.queryByText(/postgres:/)).toBeNull();
});
