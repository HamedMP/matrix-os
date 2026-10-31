import { Calendar03Icon, GithubIcon, Globe02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { OnboardingTaskDefinition } from "@matrix-os/contracts";

/** One icon per starter-task tone, shared by the widget and the Getting started app. */
export const ONBOARDING_TASK_ICONS: Record<OnboardingTaskDefinition["tone"], IconSvgElement> = {
  research: Search01Icon,
  plan: Calendar03Icon,
  website: Globe02Icon,
  code: GithubIcon,
};
