# PostHog post-wizard report

The wizard has completed a deep integration of your Matrix OS website project. PostHog analytics have been added with both client-side and server-side tracking, covering the full user journey from landing page to instance provisioning.

## Integration Summary

- **Client-side initialization**: Using `instrumentation-client.ts` (Next.js 15.3+ recommended approach)
- **Server-side tracking**: Created `posthog-server.ts` for server actions and Inngest functions
- **Reverse proxy**: Configured in `next.config.ts` to route through `/ingest` for better tracking reliability
- **Environment variables**: Set up `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` in `.env.local`
- **User identification**: Users are identified on successful provisioning with their Clerk ID and handle

## Events Tracked

| Event Name | Description | File |
|------------|-------------|------|
| `provision_requested` | User clicked the provision button to request a new Matrix OS instance | `src/app/dashboard/provision-button.tsx` |
| `provision_completed` | Server successfully provisioned a new Matrix OS instance | `src/app/dashboard/actions.ts` |
| `provision_failed` | Provisioning failed (tracked on both client and server) | `src/app/dashboard/provision-button.tsx`, `src/app/dashboard/actions.ts` |
| `admin_container_action` | Admin performed an action (start/stop/destroy) on a container | `src/app/admin/admin-dashboard.tsx` |
| `inngest_provision_started` | Inngest started processing user provisioning event | `src/inngest/provision-user.ts` |
| `inngest_provision_completed` | Inngest completed processing user provisioning event | `src/inngest/provision-user.ts` |
| `inngest_provision_failed` | Inngest provisioning step failed | `src/inngest/provision-user.ts` |

## Files Created/Modified

| File | Change |
|------|--------|
| `instrumentation-client.ts` | Created - PostHog client initialization |
| `next.config.ts` | Modified - Added reverse proxy rewrites |
| `src/lib/posthog-server.ts` | Created - Server-side PostHog client |
| `src/app/dashboard/provision-button.tsx` | Modified - Added provision tracking |
| `src/app/dashboard/actions.ts` | Modified - Added server-side provision tracking |
| `src/app/admin/admin-dashboard.tsx` | Modified - Added admin action tracking |
| `src/inngest/provision-user.ts` | Modified - Added Inngest pipeline tracking |
| `.env.local` | Modified - Added PostHog environment variables |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

### Dashboard
- [Analytics basics](https://eu.posthog.com/project/127225/dashboard/525504) - Core analytics dashboard for Matrix OS website

### Insights
- [Provisioning Activity](https://eu.posthog.com/project/127225/insights/zmh6xomU) - Track instance provisioning requests, completions, and failures over time
- [Signup to Provision Funnel](https://eu.posthog.com/project/127225/insights/075z5a9j) - Conversion funnel from page view to provisioning completion
- [Admin Container Actions](https://eu.posthog.com/project/127225/insights/7tspCD9Y) - Track admin actions on containers (start, stop, destroy)
- [Inngest Provisioning Pipeline](https://eu.posthog.com/project/127225/insights/Fbl7jGBq) - Track automated provisioning via Inngest
- [Provisioning Success Rate](https://eu.posthog.com/project/127225/insights/c8sAMDG8) - Ratio of successful provisioning to total requests

## Agent skill

We've left an agent skill folder in your project at `.claude/skills/posthog-integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
