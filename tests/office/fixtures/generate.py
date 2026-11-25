#!/usr/bin/env python3
"""Generate the office test fixtures and their expected outputs.

Run with the validation virtualenv (python-docx, openpyxl, lxml):

    <venv>/bin/python tests/office/fixtures/generate.py [--check]

Writes every fixture next to this file, then cross-checks each one with the independent
validators in ../tools and writes expected/ files (JSON summaries and plain text) that
the TypeScript suite can compare against without Python. --check regenerates in memory
and fails if any committed file differs (byte-for-byte determinism check).
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "tools"))

from generator import docx_basic, docx_contract, docx_review, xlsx_fixtures, xlsx_models  # noqa: E402
from generator.contract_text import V2_EDITS  # noqa: E402

import accept_all  # noqa: E402
import validate_docx  # noqa: E402
import validate_xlsx  # noqa: E402

MAX_BYTES = 200 * 1024

FIXTURES = {
    "basic.docx": docx_basic.basic,
    "numbering.docx": docx_basic.numbering,
    "table.docx": docx_basic.table,
    "unicode.docx": docx_basic.unicode_doc,
    "comments.docx": docx_review.comments,
    "footnotes-headers.docx": docx_review.footnotes_headers,
    "tracked.docx": docx_review.tracked,
    "links-fields.docx": docx_review.links_fields,
    "contract.docx": docx_contract.contract,
    "contract-v2.docx": docx_contract.contract_v2,
    "basic.xlsx": xlsx_fixtures.basic,
    "formulas.xlsx": xlsx_fixtures.formulas,
    "formats.xlsx": xlsx_fixtures.formats,
    "multi-sheet.xlsx": xlsx_models.multi_sheet,
    "model.xlsx": xlsx_models.model,
    "data.csv": xlsx_models.data_csv,
}


def _json(data) -> bytes:
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build() -> dict[str, bytes]:
    """Return {relative path: bytes} for every fixture and expected file."""
    outputs: dict[str, bytes] = {}
    for name, factory in FIXTURES.items():
        data = factory()
        if len(data) > MAX_BYTES:
            raise SystemExit(f"{name} is {len(data)} bytes, over the {MAX_BYTES} byte limit")
        outputs[name] = data

    with tempfile.TemporaryDirectory() as tmp:
        for name, data in outputs.items():
            (Path(tmp) / name).write_bytes(data)
        expected: dict[str, bytes] = {}
        for name in FIXTURES:
            path = str(Path(tmp) / name)
            if name.endswith(".docx"):
                summary = validate_docx.validate(path)
                texts = accept_all.resolve(path)
                expected[f"expected/{name}.txt"] = (texts["accept"] + "\n").encode("utf-8")
                if summary["revisions"]["total"]:
                    expected[f"expected/{name}.reject.txt"] = (texts["reject"] + "\n").encode("utf-8")
            elif name.endswith(".xlsx"):
                summary = validate_xlsx.validate(path, max_formulas=500)
            else:
                continue
            if not summary["valid"]:
                raise SystemExit(f"{name} failed validation: {summary['errors']}")
            expected[f"expected/{name}.summary.json"] = _json(summary)

    v1_text, v2_text = docx_contract.contract_texts()
    for stem, text in (("contract", v1_text), ("contract-v2", v2_text)):
        extracted = expected[f"expected/{stem}.docx.txt"].decode("utf-8").rstrip("\n")
        if extracted != text:
            raise SystemExit(f"{stem}.docx text does not match its source text")
    expected["expected/contract-edits.json"] = _json(V2_EDITS)
    outputs.update(expected)
    return outputs


def main(argv: list[str]) -> int:
    outputs = build()
    if "--check" in argv:
        stale = [name for name, data in outputs.items()
                 if not (HERE / name).exists() or (HERE / name).read_bytes() != data]
        if stale:
            print("stale or non-deterministic fixtures: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"{len(outputs)} files up to date")
        return 0
    (HERE / "expected").mkdir(exist_ok=True)
    for name, data in outputs.items():
        (HERE / name).write_bytes(data)
        print(f"wrote {name} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
