export { OnboardingWidget } from "./OnboardingWidget.js";
export { AI_KEY_MAX_CHARS } from "./helpers.js";
export { AppLogo, OnboardingTaskButton, RabbitAvatar } from "./parts.js";
export { ONBOARDING_TASK_ICONS } from "./task-icons.js";
export {
  onboardingWidgetStatus,
  requestOnboardingTask,
  requestOnboardingWidgetShow,
  useOnboardingTaskRequests,
  useOnboardingWidgetStatus,
  usePublishOnboardingWidgetStatus,
  type OnboardingWidgetActivity,
  type OnboardingWidgetStatus,
} from "./task-requests.js";
export * from "./host/index.js";
export {
  DEFAULT_ONBOARDING_POSITION,
  isOnboardingCornerPosition,
  onboardingCornerPosition,
  onboardingEdgeGaps,
  onboardingFittedEdgeGaps,
  onboardingPlacement,
  onboardingPositionFromRect,
  onboardingSupportDockCorner,
  type OnboardingWidgetBox,
  type OnboardingWidgetEdgeGaps,
  type OnboardingWidgetPlacement,
  type OnboardingWidgetPosition,
} from "./position.js";
export type {
  OnboardingAppCategory,
  OnboardingWidgetActions,
  OnboardingWidgetApp,
  OnboardingWidgetPrefs,
  OnboardingWidgetProps,
  OnboardingWidgetRepo,
} from "./types.js";
