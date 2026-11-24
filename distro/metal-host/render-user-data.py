#!/usr/bin/env python3
"""Render cloud-init user-data for metal-host VMs.

builder: the unchanged golden builder template
(distro/customer-vps/golden-snapshot-builder-cloud-init.yaml) with its
placeholders filled from --var, plus a second MIME part (text/x-shellscript)
that applies the S7 guest settings and installs the guest agent. The template
is not edited: its runcmd and finalizer run exactly as on any provider.

smoke: the customer cloud-init (distro/customer-vps/cloud-init.yaml) for an
unregistered smoke VM cloned from a golden disk. Platform values are local
random secrets, the image source is the golden snapshot (fast path), and
/opt/matrix/restore-complete is pre-created because an unregistered VM cannot
reach the object store restore gate (as in the S7 spike).

Usage:
  render-user-data.py builder --template T --guest-dir D --guest-agent A --var k=v... --out O
  render-user-data.py smoke --template T --var k=v... [--ssh-key FILE] --out O
"""
import argparse
import base64
import os
import re
import secrets
import sys
import uuid
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

PLACEHOLDER = re.compile(r"\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}")
SAFE_VALUE = re.compile(r"^[A-Za-z0-9._:/@+=,~ -]*$")
GUEST_FILES = {
    "@@GUEST_AGENT_UNIT_B64@@": "matrix-guest-agent.service",
    "@@GUEST_AGENT_VSOCK_UNIT_B64@@": "matrix-guest-agent-vsock.service",
    "@@PHC2SYS_UNIT_B64@@": "phc2sys-kvm.service",
}


def fail(message):
    sys.stderr.write(f"render-user-data: {message}\n")
    sys.exit(2)


def parse_vars(pairs):
    values = {}
    for pair in pairs or []:
        key, sep, value = pair.partition("=")
        if not sep or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*", key):
            fail(f"bad --var {key!r}")
        # Values land inside YAML scalars and shell strings; keep them plain.
        if not SAFE_VALUE.fullmatch(value) or len(value) > 2048:
            fail(f"unsafe value for {key}")
        values[key] = value
    return values


def fill(text, values):
    missing = set()

    def sub(match):
        key = match.group(1)
        if key not in values:
            missing.add(key)
            return match.group(0)
        return values[key]

    # Only {{camelCase}} placeholders; docker's {{.Names}} stays as written.
    out = PLACEHOLDER.sub(sub, text)
    if missing:
        fail(f"unrendered placeholders: {sorted(missing)}")
    return out


def b64_file(path):
    with open(path, "rb") as handle:
        return base64.b64encode(handle.read()).decode()


def write_out(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(data)


def render_builder(args):
    with open(args.template) as handle:
        cloud_config = fill(handle.read(), parse_vars(args.var))
    with open(os.path.join(args.guest_dir, "metal-guest-setup.sh")) as handle:
        script = handle.read()
    for marker, name in GUEST_FILES.items():
        script = script.replace(marker, b64_file(os.path.join(args.guest_dir, name)))
    script = script.replace("@@GUEST_AGENT_B64@@", b64_file(args.guest_agent))
    if "@@" in script:
        fail("guest setup script has an unfilled marker")
    message = MIMEMultipart("mixed")
    part = MIMEText(cloud_config, "cloud-config", "utf-8")
    part.add_header("Content-Disposition", "attachment", filename="matrix-golden-builder.yaml")
    message.attach(part)
    part = MIMEText(script, "x-shellscript", "utf-8")
    part.add_header("Content-Disposition", "attachment", filename="00-matrix-metal-guest.sh")
    message.attach(part)
    write_out(args.out, message.as_string())


def render_smoke(args):
    import yaml  # python3-yaml; only the smoke path needs it.

    token = lambda: secrets.token_urlsafe(32)
    given = parse_vars(args.var)
    for required in ("handle", "imageVersion", "targetBundleSha256"):
        if required not in given:
            fail(f"--var {required}=... is required")
    values = {
        "machineId": str(uuid.uuid4()),
        "clerkUserId": f"smoke_{given['handle']}",
        "runtimeSlot": "primary",
        "runtimeTokenEpoch": "1",
        "developerTools": "",
        "imageSource": "snapshot",
        "snapshotSourceVersion": given["imageVersion"],
        "updateChannel": "stable",
        "hostBundleUrl": "",
        "platformRegisterUrl": "",
        "platformInternalUrl": "",
        "platformVerificationToken": token(),
        "syncRuntimeToken": token(),
        "fundedAiRuntimeToken": token(),
        "platformSpeechEnabled": "false",
        "platformSpeechOrigin": "",
        "platformSpeechRuntimeToken": token(),
        "registrationToken": token(),
        "registrationTokenExpiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "postgresPassword": secrets.token_hex(24),
        "posthogToken": "",
        "posthogProjectToken": "",
        "posthogHost": "",
        "posthogPublicHost": "",
        "posthogApiHost": "",
        "fundedAiEnabled": "false",
        "fundedAiRelayUrl": "",
        "getStartedEnabled": "false",
        "updateManifestBaseUrlEnv": "",
        "collaborationDisabledEnv": "",
        "collaborationPairEnv": "",
        "previewRuntimeEnv": "",
        "supportPublicKey": "",
    }
    values.update(given)
    with open(args.template) as handle:
        doc = yaml.safe_load(fill(handle.read(), values))
    doc.setdefault("write_files", []).append(
        {"path": "/opt/matrix/restore-complete", "content": "", "permissions": "0644"}
    )
    if args.ssh_key:
        with open(args.ssh_key) as handle:
            key = handle.read().strip()
        doc.setdefault("users", []).insert(0, {
            "name": "ubuntu",
            "groups": ["sudo"],
            "sudo": "ALL=(ALL) NOPASSWD:ALL",
            "shell": "/bin/bash",
            "ssh_authorized_keys": [key],
        })
    write_out(args.out, "#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False, width=10_000))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    builder = sub.add_parser("builder")
    builder.add_argument("--template", required=True)
    builder.add_argument("--guest-dir", required=True)
    builder.add_argument("--guest-agent", required=True)
    builder.add_argument("--var", action="append")
    builder.add_argument("--out", required=True)
    smoke = sub.add_parser("smoke")
    smoke.add_argument("--template", required=True)
    smoke.add_argument("--var", action="append")
    smoke.add_argument("--ssh-key")
    smoke.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.mode == "builder":
        render_builder(args)
    else:
        render_smoke(args)


if __name__ == "__main__":
    main()
