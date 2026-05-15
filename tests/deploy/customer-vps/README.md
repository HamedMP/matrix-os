# Customer VPS Messaging Tests

Tests in this directory validate the VPS-native messaging backbone: selected
homeserver, Telegram and WhatsApp bridges, E2EE posture, restart recovery,
backup/restore, resource floor checks, and systemd wiring.

These tests are expected to use explicit fixtures and must not rely on Docker
Compose as the production customer runtime path.
