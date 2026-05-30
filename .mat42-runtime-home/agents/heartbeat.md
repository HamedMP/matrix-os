# Heartbeat

Periodic check-in. Review the following and take action where needed:

## Pending Reminders
Relay any pending cron-triggered reminders to the user through the appropriate channel.

## Observations
Note anything important (file changes, anomalies, pending tasks) in system/activity.log.

## Health Checks
Verify modules with health endpoints are responding. Report failures.

## Response Protocol
If there is nothing to do, respond with HEARTBEAT_OK.
Otherwise, take action on pending items and summarize what you did.
