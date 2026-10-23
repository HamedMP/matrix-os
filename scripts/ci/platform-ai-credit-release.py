#!/usr/bin/env python3
"""Validate existing credit settings and canonical Stripe delivery before release.

Read-only: renders deployment bindings or validates filtered endpoint metadata.
It never changes Stripe configuration, enables a feature, or issues credit.
"""
import argparse
import json
import os
import re
import sys
import uuid

SUBSCRIPTION = "MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED"
TAX = "MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED"
SCOPE = "MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS"
REQUIRED_EVENTS = (
    "customer.subscription.created", "customer.subscription.updated",
    "customer.subscription.deleted", "customer.subscription.trial_will_end",
    "checkout.session.completed", "checkout.session.expired",
    "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
    "invoice.paid", "invoice.payment_failed", "charge.refunded",
    "charge.dispute.created", "charge.dispute.closed",
)


class MissingStripeEvent(ValueError):
    pass


def configuration():
    values = {}
    for key in (SUBSCRIPTION, TAX):
        value = os.environ.get(key, "") or "false"
        if value not in ("true", "false"):
            raise ValueError(f"{key} must be true or false")
        values[key] = value
    if values[SUBSCRIPTION] == "true" and os.environ.get("MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED") != "true":
        raise ValueError("Subscription credit requires the funded AI control plane")
    scope = os.environ.get(SCOPE, "")
    # Empty GitHub configuration means no machine restriction. A configured
    # restriction must survive deployment exactly, never become global on error.
    if scope:
        if len(scope) > 4096:
            raise ValueError("Invalid AI credit checkout machine scope")
        ids = json.loads(scope)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 32:
            raise ValueError("Invalid AI credit checkout machine scope")
        for value in ids:
            if not isinstance(value, str) or not re.fullmatch(
                r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value
            ):
                raise ValueError("Invalid AI credit checkout machine scope")
            parsed = uuid.UUID(value)
            if parsed.int not in (0, (1 << 128) - 1) and (
                parsed.variant != uuid.RFC_4122 or parsed.version not in range(1, 9)
            ):
                raise ValueError("Invalid AI credit checkout machine scope")
        values[SCOPE] = json.dumps(ids, separators=(',', ':'))
    return values


def read_metadata():
    raw = sys.stdin.read(262145)
    if len(raw) > 262144:
        raise ValueError("Invalid release metadata size")
    return raw


def verify_revision():
    revision = json.loads(read_metadata())
    actual = revision["spec"]["containers"][0]["env"]
    expected = configuration()
    for key in (SUBSCRIPTION, TAX, SCOPE):
        rows = [row for row in actual if row.get("name") == key]
        if key not in expected:
            if rows:
                raise ValueError("Unexpected checkout machine scope on deployed revision")
        elif len(rows) != 1 or rows[0].get("value") != expected[key]:
            raise ValueError("AI credit configuration missing or incorrect on deployed revision")


def verify_webhook():
    raw = read_metadata()
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if len(rows) != 1 or not isinstance(rows[0], dict) or rows[0].get("status") != "enabled":
        raise ValueError("Exactly one enabled canonical Stripe webhook endpoint is required")
    events = rows[0].get("enabled_events")
    if not isinstance(events, list) or not all(isinstance(event, str) for event in events):
        raise ValueError("Invalid Stripe webhook event subscription")
    for event in REQUIRED_EVENTS:
        if "*" not in events and event not in events:
            raise MissingStripeEvent(f"Stripe webhook is missing required event: {event}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("validate", "env-bindings", "verify-webhook", "verify-revision"))
    mode = parser.parse_args().mode
    try:
        if mode == "verify-webhook":
            verify_webhook()
        elif mode == "verify-revision":
            verify_revision()
        else:
            value = configuration()
            if mode == "env-bindings":
                print("".join(f"|{key}={item}" for key, item in value.items()), end="")
    except MissingStripeEvent as error:
        print(str(error), file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        # Never echo supplied configuration or raw provider metadata.
        print("AI credit release configuration or webhook delivery is invalid", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
