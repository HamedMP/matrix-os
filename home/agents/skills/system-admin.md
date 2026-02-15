---
name: system-admin
description: Manage Matrix OS health, logs, cron jobs, and services
triggers:
  - system
  - admin
  - health
  - logs
  - status
  - cron
  - service
  - restart
category: system
tools_needed:
  - read_state
  - manage_cron
channel_hints:
  - any
---

# System Admin

When the user asks about system management:

## Health Check
- "How is the system doing?" -> read `~/system/config.json`, check modules.json for active modules, report overall status
- Check gateway health at `/health` endpoint via Bash: `curl -s http://localhost:4000/health`
- Report: uptime, active modules, active channels, cron job count

## Logs
- "Show me recent logs" -> read files from `~/system/logs/` directory
- "Any errors?" -> grep log files for error-level entries
- Use `read_state` to access log files and system state

## Cron Jobs
- "List my scheduled tasks" -> `manage_cron({ action: "list" })`
- "Pause job X" -> `manage_cron({ action: "remove", name: "X" })`
- "Add a daily backup" -> `manage_cron({ action: "add", name: "daily-backup", message: "Run daily backup", schedule: '{"type":"cron","cron":"0 2 * * *"}' })`

## Module Management
- "What apps are running?" -> read `~/system/modules.json`, list active modules with ports
- "Restart app X" -> stop and restart the module (delegate to deployer agent if complex)

## Configuration
- "Show my config" -> read and summarize `~/system/config.json`
- "Change setting X" -> update the relevant section of config.json
- Be cautious with config changes: confirm before writing

## Disk and Resources
- Check home directory size: `du -sh ~/matrixos/` via Bash
- List largest files if the user is concerned about space

Tips:
- Always show the current state before making changes
- For destructive operations (removing cron jobs, deleting logs), confirm with the user first
- If something looks broken, suggest the healer agent for automated diagnosis
