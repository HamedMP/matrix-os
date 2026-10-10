"""Validate operator-reviewed routing for one exact same-repository Preview Chat.

This selects a route, never a user identity or integration authorization.
Private selector values are read from files and never emitted to logs.
"""
import argparse
import datetime
import json
import os
import re
import sys
import tomllib
import urllib.parse
from pathlib import Path

LABEL = "preview-chat-candidate-route"
MAX_JSON = 1_048_576


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def read_json(path=None):
    if path is None:
        raw = sys.stdin.buffer.read(MAX_JSON + 1)
    else:
        with Path(path).open("rb") as source:
            raw = source.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise ValueError("Oversized JSON")
    value = json.loads(raw, object_pairs_hook=unique_keys)
    if not isinstance(value, dict):
        raise ValueError("Expected object")
    return value


def verify_pr(value, args, require_labels=False):
    head = value.get("head", {})
    if (type(value.get("number")) is not int or value["number"] != int(args.pr)
        or value.get("state") != "open" or head.get("sha") != args.sha
        or head.get("ref") != args.ref or head.get("repo", {}).get("full_name") != args.repository):
        raise ValueError("PR identity drift")
    if require_labels and not any(isinstance(label, dict) and label.get("name") == LABEL
                                  for label in value.get("labels", [])):
        raise ValueError("Approval label removed")


def admit(args):
    if (not re.fullmatch(r"[1-9][0-9]{0,8}", args.pr)
        or not re.fullmatch(r"[0-9a-f]{40}", args.sha)
        or not 1 <= len(args.ref) <= 255 or re.search(r"[\x00-\x20\x7f]", args.ref)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository)):
        raise ValueError("Invalid event identity")
    event = read_json(args.event)
    if event.get("action") != "labeled" or event.get("label", {}).get("name") != LABEL:
        raise ValueError("Wrong trigger")
    verify_pr(event.get("pull_request", {}), args)


def origin_allowed(origin, base_text, pr):
    if not isinstance(origin, str) or re.search(r"[\x00-\x20\x7f]", origin):
        return False
    base = urllib.parse.urlsplit(base_text)
    candidate = urllib.parse.urlsplit(origin)
    host = candidate.hostname or ""
    suffix = "---" + (base.hostname or "")
    tag = host[:-len(suffix)] if host.endswith(suffix) else ""
    return (base.scheme == "https" and (base.hostname or "").endswith(".run.app")
            and base.netloc == base.hostname and base.path in ("", "/") and not base.query and not base.fragment
            and candidate.scheme == "https" and not candidate.username and not candidate.password
            and candidate.port is None and candidate.netloc == host
            and candidate.path in ("", "/") and not candidate.query and not candidate.fragment
            and re.fullmatch(r"pr" + re.escape(pr) + r"(?:-[a-z0-9]+)+", tag) is not None)


def selector(args):
    data = read_json(args.raw)
    if set(data) != {"prNumber", "approvedHeadSha", "approvedHeadRef", "handle",
                     "chatId", "candidateOrigin", "expiresAt"}:
        raise ValueError("Invalid selector fields")
    if (type(data["prNumber"]) is not int or data["prNumber"] != int(args.pr)
        or data["approvedHeadSha"] != args.sha or data["approvedHeadRef"] != args.ref
        or data["handle"] != "pr-" + args.pr or not isinstance(data["chatId"], str)
        or not re.fullmatch(r"chat_[A-Za-z0-9_-]{1,128}", data["chatId"])):
        raise ValueError("Unapproved selector identity")
    expiry_text = data["expiresAt"]
    if not isinstance(expiry_text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", expiry_text):
        raise ValueError("Invalid expiry")
    expiry = datetime.datetime.fromisoformat(expiry_text.replace("Z", "+00:00"))
    if not 0 < (expiry - datetime.datetime.now(datetime.timezone.utc)).total_seconds() <= 7200:
        raise ValueError("Expired selector")
    base = tomllib.loads(Path(args.config).read_text())["vars"]["PLATFORM_ORIGIN"]
    if not origin_allowed(data["candidateOrigin"], base, args.pr):
        raise ValueError("Wrong Platform service or PR tag")
    bindings = {"PREVIEW_CHAT_CANDIDATE_ORIGIN": data["candidateOrigin"],
                "PREVIEW_CHAT_CANDIDATE_HANDLE": data["handle"],
                "PREVIEW_CHAT_CANDIDATE_CHAT_ID": data["chatId"],
                "PREVIEW_CHAT_CANDIDATE_EXPIRES_AT": expiry_text}
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(bindings, output, separators=(",", ":"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("admit", "current", "selector"))
    for name in ("event", "repository", "pr", "sha", "ref"):
        parser.add_argument("--" + name, required=True)
    for name in ("raw", "output", "config"):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    try:
        admit(args)
        if args.mode == "current":
            verify_pr(read_json(), args, require_labels=True)
        if args.mode == "selector":
            if not all((args.raw, args.output, args.config)):
                raise ValueError("Missing selector paths")
            selector(args)
    except (ValueError, TypeError, KeyError, AttributeError, OSError, UnicodeError, RecursionError):
        raise SystemExit("Candidate verification failed") from None


if __name__ == "__main__":
    main()
