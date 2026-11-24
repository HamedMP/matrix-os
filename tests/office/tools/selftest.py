#!/usr/bin/env python3
"""Self-test for the validators and the accept/reject tool.

Usage: python selftest.py     (exit 0 when every check passes)

It runs the command-line tools as subprocesses against the committed fixtures and
against deliberately broken copies, so it tests the same entry points people use.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
FIXTURES = TOOLS.parent / "fixtures"
failures: list[str] = []


def tool(name: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(TOOLS / name), *args], capture_output=True, text=True, timeout=60)


def check(condition: bool, message: str) -> None:
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        failures.append(message)


def rewrite(source: Path, target: Path, edit) -> None:
    """Copy a ZIP package, letting edit(name, data) return new bytes or None to drop a part."""
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = edit(info.filename, src.read(info))
            if data is not None:
                dst.writestr(info.filename, data)


def expect_invalid(validator: str, path: Path, reason: str) -> None:
    result = tool(validator, str(path))
    payload = json.loads(result.stdout) if result.stdout.strip() else {}
    joined = " ".join(payload.get("errors", []))
    check(result.returncode == 1 and reason in joined and "INVALID" in result.stderr,
          f"{validator} rejects {path.name}: expects '{reason}', got rc={result.returncode} {joined!r}")


def main() -> int:
    for fixture in sorted(FIXTURES.glob("*.docx")):
        result = tool("validate_docx.py", str(fixture))
        check(result.returncode == 0 and json.loads(result.stdout)["valid"], f"validate_docx accepts {fixture.name}")
    for fixture in sorted(FIXTURES.glob("*.xlsx")):
        result = tool("validate_xlsx.py", str(fixture))
        check(result.returncode == 0 and json.loads(result.stdout)["valid"], f"validate_xlsx accepts {fixture.name}")

    summary = json.loads(tool("validate_docx.py", str(FIXTURES / "tracked.docx")).stdout)
    check(summary["revisions"]["byKind"] == {"del": 4, "ins": 11, "moveFrom": 2, "moveTo": 2, "pPrChange": 1, "rPrChange": 1},
          "tracked.docx revision counts by kind")
    check(sorted(summary["revisions"]["byAuthor"]) == ["Alex Morgan", "Priya Shah"], "tracked.docx has two authors")
    comments = json.loads(tool("validate_docx.py", str(FIXTURES / "comments.docx")).stdout)["comments"]
    check(comments["count"] == 3 and comments["replies"] == 1, "comments.docx has three comments and one reply")
    model = json.loads(tool("validate_xlsx.py", str(FIXTURES / "model.xlsx")).stdout)
    check(model["sheetNames"] == ["Assumptions", "Projection", "Summary"], "model.xlsx sheet names")
    check(all(s["formulasWithoutCachedValue"] == 0 for s in model["sheets"]), "model.xlsx formulas all have cached values")

    accepted = tool("accept_all.py", str(FIXTURES / "tracked.docx")).stdout
    rejected = tool("accept_all.py", str(FIXTURES / "tracked.docx"), "--reject").stdout
    check("revised report within fifteen business days" in accepted and "ten" not in accepted.split("\n")[1],
          "accept-all keeps insertions and drops deletions")
    check("rise by up to three percent" in accepted and "five" not in accepted, "accept-all drops text deleted inside an insertion")
    check("This obsolete sentence is removed." not in accepted, "accept-all removes a deleted paragraph")
    check(accepted.count("This paragraph will be moved to the end.") == 1 and
          accepted.strip().endswith("This paragraph will be moved to the end.\nEnd of sample."), "accept-all moves text to the destination")
    check("deliver the report within ten business days" in rejected and "Thereafter" not in rejected,
          "reject-all restores deleted text and drops insertions")
    check("Widgets" not in rejected and "Widgets\t10" in accepted, "inserted table row follows accept/reject")
    check(rejected.split("\n")[3] == "This paragraph will be moved to the end.", "reject-all keeps moved text at its source")
    check(accepted == (FIXTURES / "expected/tracked.docx.txt").read_text(encoding="utf-8"), "accept output matches expected/tracked.docx.txt")
    check(rejected == (FIXTURES / "expected/tracked.docx.reject.txt").read_text(encoding="utf-8"), "reject output matches expected/tracked.docx.reject.txt")
    both = json.loads(tool("accept_all.py", str(FIXTURES / "tracked.docx"), "--json").stdout)
    check(set(both) == {"accept", "reject"}, "accept_all --json returns both views")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        docx = FIXTURES / "basic.docx"
        xlsx = FIXTURES / "formulas.xlsx"

        bad = tmp_path / "not-a-zip.docx"
        bad.write_bytes(b"plain text, not a package")
        expect_invalid("validate_docx.py", bad, "not a ZIP package")

        bad = tmp_path / "malformed.docx"
        rewrite(docx, bad, lambda n, d: d.replace(b"</w:body>", b"</w:bod>") if n == "word/document.xml" else d)
        expect_invalid("validate_docx.py", bad, "not well-formed XML")

        bad = tmp_path / "no-content-type.docx"
        rewrite(docx, bad, lambda n, d: re.sub(rb'<Default Extension="jpeg"[^>]*/>', b"", d) if n == "[Content_Types].xml" else d)
        expect_invalid("validate_docx.py", bad, "has no content type")

        bad = tmp_path / "dangling-rel.docx"
        rewrite(docx, bad, lambda n, d: None if n == "word/styles.xml" else d)
        expect_invalid("validate_docx.py", bad, "not in the package")

        bad = tmp_path / "missing-target.docx"
        rewrite(docx, bad, lambda n, d: d.replace(b'Target="theme/theme1.xml"', b'Target="theme/missing.xml"')
                if n == "word/_rels/document.xml.rels" else d)
        expect_invalid("validate_docx.py", bad, "targets missing part")

        bad = tmp_path / "dtd.docx"
        rewrite(docx, bad, lambda n, d: d.replace(b"?>", b'?><!DOCTYPE w:document [<!ENTITY x "boom">]>', 1)
                if n == "word/document.xml" else d)
        expect_invalid("validate_docx.py", bad, "DTD")

        bad = tmp_path / "anonymous-revision.docx"
        rewrite(FIXTURES / "tracked.docx", bad, lambda n, d: d.replace(b' w:author="Alex Morgan"', b"", 1)
                if n == "word/document.xml" else d)
        expect_invalid("validate_docx.py", bad, "have no w:author")

        bad = tmp_path / "dangling-comment.docx"
        rewrite(FIXTURES / "comments.docx", bad, lambda n, d: d.replace(b'<w:commentReference w:id="1"/>',
                b'<w:commentReference w:id="9"/>') if n == "word/document.xml" else d)
        expect_invalid("validate_docx.py", bad, "comment references without a comment")

        bad = tmp_path / "bad-shared-string.xlsx"
        rewrite(FIXTURES / "basic.xlsx", bad, lambda n, d: d.replace(b't="s"><v>0</v>', b't="s"><v>999</v>', 1)
                if n.startswith("xl/worksheets/") else d)
        expect_invalid("validate_xlsx.py", bad, "shared string index")

        bad = tmp_path / "malformed.xlsx"
        rewrite(xlsx, bad, lambda n, d: d[:-20] if n == "xl/workbook.xml" else d)
        expect_invalid("validate_xlsx.py", bad, "not well-formed XML")

        bad = tmp_path / "zip-slip.xlsx"
        buffer = io.BytesIO(xlsx.read_bytes())
        with zipfile.ZipFile(buffer, "a") as archive:
            archive.writestr("../escape.xml", "<x/>")
        bad.write_bytes(buffer.getvalue())
        expect_invalid("validate_xlsx.py", bad, "unsafe ZIP entry name")

        check(tool("validate_docx.py").returncode == 2, "validate_docx without arguments exits 2")

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
