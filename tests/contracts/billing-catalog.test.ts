import { describe, expect, it } from "vitest";

import {
  MATRIX_HOSTED_BILLING_PLANS,
  MATRIX_HOSTED_BILLING_REGIONS,
  closestMatrixRegionSlug,
  resolveMatrixMachineProfile,
} from "@matrix-os/contracts";

describe("hosted billing catalog", () => {
  it("publishes the monthly Starter, Builder, and Max prices", () => {
    expect(MATRIX_HOSTED_BILLING_PLANS.map((plan) => [plan.slug, plan.monthlyUsd])).toEqual([
      ["matrix_starter", 20],
      ["matrix_builder", 100],
      ["matrix_max", 200],
    ]);
  });

  it("maps every plan to its EU and US Hetzner shape", () => {
    expect(MATRIX_HOSTED_BILLING_REGIONS.map((region) => region.slug)).toEqual([
      "region_fsn1",
      "region_nbg1",
      "region_ash",
      "region_hil",
    ]);

    expect(resolveMatrixMachineProfile("matrix_starter", "region_fsn1")).toMatchObject({
      serverType: "cpx22", vcpus: 2, memoryGb: 4, diskGb: 80,
    });
    expect(resolveMatrixMachineProfile("matrix_builder", "region_nbg1")).toMatchObject({
      serverType: "cpx42", vcpus: 8, memoryGb: 16, diskGb: 320,
    });
    expect(resolveMatrixMachineProfile("matrix_max", "region_fsn1")).toMatchObject({
      serverType: "cpx52", vcpus: 12, memoryGb: 24, diskGb: 480,
    });
    expect(resolveMatrixMachineProfile("matrix_starter", "region_ash")).toMatchObject({
      serverType: "cpx21", vcpus: 3, memoryGb: 4, diskGb: 80,
    });
    expect(resolveMatrixMachineProfile("matrix_builder", "region_hil")).toMatchObject({
      serverType: "cpx31", vcpus: 4, memoryGb: 8, diskGb: 160,
    });
    expect(resolveMatrixMachineProfile("matrix_max", "region_ash")).toMatchObject({
      serverType: "cpx41", vcpus: 8, memoryGb: 16, diskGb: 240,
    });
  });

  it("chooses the nearest regional site from an IANA timezone with a deterministic fallback", () => {
    expect(closestMatrixRegionSlug("America/Los_Angeles")).toBe("region_hil");
    expect(closestMatrixRegionSlug("America/New_York")).toBe("region_ash");
    expect(closestMatrixRegionSlug("Europe/Berlin")).toBe("region_fsn1");
    expect(closestMatrixRegionSlug("Europe/Paris")).toBe("region_nbg1");
    expect(closestMatrixRegionSlug("Asia/Tokyo")).toBe("region_hil");
    expect(closestMatrixRegionSlug(undefined)).toBe("region_fsn1");
  });
});
