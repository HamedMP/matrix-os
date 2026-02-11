# Heartbeat Agent

Periodic health check agent. Monitors module health endpoints and triggers healing when failures are detected.

## Schedule

- Check all modules with `/health` endpoints every 30 seconds
- Report failures to kernel via IPC messaging
- Trigger healer agent on consecutive failures (3+ in a row)
