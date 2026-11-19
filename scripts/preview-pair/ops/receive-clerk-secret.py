"""Receive only the newly created, dedicated development key via a hidden prompt.

No secret is printed, put in argv, or persisted locally. The normal authenticated
gcloud CLI sends its stdin directly to the explicitly selected Secret Manager.
"""
import getpass
import re
import subprocess

secret = getpass.getpass("Dedicated Clerk development key (hidden): ")
if not re.fullmatch(r"sk_test_[A-Za-z0-9_=-]{1,500}", secret):
    raise SystemExit("Expected a Clerk development key; nothing was stored.")
subprocess.run(
    [
        "gcloud", "secrets", "versions", "add", "matrix-pair-preview-clerk-secret",
        "--project=matrix-os-1144", "--data-file=-",
    ],
    input=secret.encode(),
    check=True,
    timeout=30,
)
secret = ""
