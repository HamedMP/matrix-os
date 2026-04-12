#!/usr/bin/env bash
set -euo pipefail

# Setup two Matrix accounts on local Conduit for spec 062 testing.
# Prerequisite: `bun run docker:multi` must be running (starts Conduit on :6167).
#
# This script:
#   1. Registers alice + bob on the local Conduit homeserver
#   2. Extracts access tokens from the registration response
#   3. Updates .env.docker with the tokens
#   4. Tells you to restart the containers

CONDUIT_URL="http://localhost:6167"
ENV_FILE=".env.docker"

echo "Checking Conduit is reachable..."
if ! curl -sf "$CONDUIT_URL/_matrix/client/versions" > /dev/null 2>&1; then
  echo "ERROR: Conduit not reachable at $CONDUIT_URL"
  echo "Start it first: bun run docker:multi"
  exit 1
fi
echo "Conduit OK"

echo ""
echo "=== Registering @alice:matrix-os.com ==="
ALICE_RESP=$(curl -sf -X POST "$CONDUIT_URL/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"test1234","auth":{"type":"m.login.dummy"}}' 2>&1 || true)

if echo "$ALICE_RESP" | jq -e '.access_token' > /dev/null 2>&1; then
  ALICE_TOKEN=$(echo "$ALICE_RESP" | jq -r '.access_token')
  echo "Registered. Token: ${ALICE_TOKEN:0:20}..."
elif echo "$ALICE_RESP" | jq -e '.errcode' 2>/dev/null | grep -q "M_USER_IN_USE"; then
  echo "alice already registered. Logging in..."
  ALICE_LOGIN=$(curl -sf -X POST "$CONDUIT_URL/_matrix/client/v3/login" \
    -H 'Content-Type: application/json' \
    -d '{"type":"m.login.password","user":"alice","password":"test1234"}')
  ALICE_TOKEN=$(echo "$ALICE_LOGIN" | jq -r '.access_token')
  echo "Logged in. Token: ${ALICE_TOKEN:0:20}..."
else
  echo "ERROR registering alice: $ALICE_RESP"
  exit 1
fi

echo ""
echo "=== Registering @bob:matrix-os.com ==="
BOB_RESP=$(curl -sf -X POST "$CONDUIT_URL/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"bob","password":"test1234","auth":{"type":"m.login.dummy"}}' 2>&1 || true)

if echo "$BOB_RESP" | jq -e '.access_token' > /dev/null 2>&1; then
  BOB_TOKEN=$(echo "$BOB_RESP" | jq -r '.access_token')
  echo "Registered. Token: ${BOB_TOKEN:0:20}..."
elif echo "$BOB_RESP" | jq -e '.errcode' 2>/dev/null | grep -q "M_USER_IN_USE"; then
  echo "bob already registered. Logging in..."
  BOB_LOGIN=$(curl -sf -X POST "$CONDUIT_URL/_matrix/client/v3/login" \
    -H 'Content-Type: application/json' \
    -d '{"type":"m.login.password","user":"bob","password":"test1234"}')
  BOB_TOKEN=$(echo "$BOB_LOGIN" | jq -r '.access_token')
  echo "Logged in. Token: ${BOB_TOKEN:0:20}..."
else
  echo "ERROR registering bob: $BOB_RESP"
  exit 1
fi

echo ""
echo "=== Updating $ENV_FILE ==="
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s|^ALICE_TOKEN=.*|ALICE_TOKEN=$ALICE_TOKEN|" "$ENV_FILE"
  sed -i '' "s|^BOB_TOKEN=.*|BOB_TOKEN=$BOB_TOKEN|" "$ENV_FILE"
else
  sed -i "s|^ALICE_TOKEN=.*|ALICE_TOKEN=$ALICE_TOKEN|" "$ENV_FILE"
  sed -i "s|^BOB_TOKEN=.*|BOB_TOKEN=$BOB_TOKEN|" "$ENV_FILE"
fi
echo "Tokens written to $ENV_FILE"

echo ""
echo "=== Done ==="
echo ""
echo "Now restart the containers to pick up the tokens:"
echo "  docker compose -f docker-compose.dev.yml --profile full --profile multi restart alice bob"
echo ""
echo "Then open:"
echo "  Alice: http://localhost:3001"
echo "  Bob:   http://localhost:3002"
echo ""
echo "Follow specs/062-shared-apps/manual-test.md for the test flow."
