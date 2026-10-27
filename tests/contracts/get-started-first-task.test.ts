import { describe, expect, it } from "vitest";
import { APP_GALLERY_BUILD_MAX_CHARS, appGalleryBuildPrompt } from "../../packages/contracts/src/app-gallery.js";
import {
  ONBOARDING_FIX_TOP_ISSUE,
  buildOnboardingPrompt,
  getStartedBuildSuggestion,
  getStartedWidgetIntro,
  initialOnboardingWidgetState,
  onboardingFollowUpPrompt,
  onboardingTask,
  reduceOnboardingWidget,
} from "../../packages/contracts/src/index.js";

const fresh = () => initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false });

describe("first code task", () => {
  it("clones and tests without changing anything", () => {
    const prompt = buildOnboardingPrompt({ taskId: "work-on-code", answer: "habit-tracker", appConnected: true, simpler: false });
    expect(prompt).toContain("run its tests");
    expect(prompt).toContain("Don't change anything yet");
  });

  it("offers to fix the top issue on a branch", () => {
    expect(onboardingTask("work-on-code")?.followUp.chips).toContain(ONBOARDING_FIX_TOP_ISSUE);
  });

  it.each([ONBOARDING_FIX_TOP_ISSUE, "Add a feature"])("ends %s in a pull request for review, never a merge", (choice) => {
    const prompt = onboardingFollowUpPrompt("work-on-code", choice, "habit-tracker") ?? "";
    expect(prompt).toContain("new branch");
    expect(prompt).toContain("pull request for my review");
    expect(prompt).toContain("Never push to the default branch or merge");
    expect(prompt).toContain("ask me before changing anything outside the repository");
  });

  it("explains a repo without code-change rules", () => {
    expect(onboardingFollowUpPrompt("work-on-code", "Explain this repo", "habit-tracker")).not.toContain("pull request");
    expect(onboardingFollowUpPrompt("work-on-code", "Not now", "habit-tracker")).toBeNull();
  });
});

describe("first app build", () => {
  it("uses App Gallery's own bounded build request", () => {
    expect(appGalleryBuildPrompt("  Track my habits  ")).toMatch(/^\[BUILD\] Build an app for my Matrix computer: Track my habits\. Use my connected tools only after I choose the accounts and approve imports\./);
    expect(appGalleryBuildPrompt(" ")).toBeNull();
    expect(appGalleryBuildPrompt("a".repeat(APP_GALLERY_BUILD_MAX_CHARS + 1))).toBeNull();
  });

  it("suggests the owner's app idea, or nothing", () => {
    expect(getStartedBuildSuggestion({ goals: ["build"], tools: [], appIdea: "habit-tracker" })).toEqual({
      title: "Habit tracker",
      prompt: appGalleryBuildPrompt("Track my habits and show my streaks"),
    });
    expect(getStartedBuildSuggestion({ goals: ["build"], tools: [] })).toBeNull();
  });

  it("starts a titled build run only when nothing else is running", () => {
    const prompt = appGalleryBuildPrompt("Track my habits and show my streaks")!;
    const state = reduceOnboardingWidget(fresh(), { type: "build.requested", title: "Habit tracker", prompt });
    expect(state.echo).toBe("Build Habit tracker");
    expect(state.screen).toMatchObject({ kind: "run", taskId: "custom", answer: prompt, title: "Build: Habit tracker", phase: "starting" });
    expect(reduceOnboardingWidget(state, { type: "build.requested", title: "Recipe box", prompt })).toBe(state);
    expect(reduceOnboardingWidget(fresh(), { type: "build.requested", title: " ", prompt })).toEqual(fresh());
  });
});

describe("widget intro", () => {
  it("speaks to the first goal and keeps today's text otherwise", () => {
    expect(getStartedWidgetIntro(["code", "build"])).toContain("run its tests");
    expect(getStartedWidgetIntro(["explore"])).toBeNull();
    expect(getStartedWidgetIntro([])).toBeNull();
  });
});
