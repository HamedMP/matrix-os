#!/usr/bin/env python3
"""Independently validate a .docx file and print a JSON summary.

Usage: python validate_docx.py <file.docx> [--quiet]

Exit codes: 0 valid, 1 invalid (reason in JSON "errors" and on stderr), 2 usage error.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ooxml_package import PackageError, load_package, main_part  # noqa: E402

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W15 = "http://schemas.microsoft.com/office/word/2012/wordml"
NS = {"w": W, "w15": W15}
REVISION_KINDS = ("ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange",
                  "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "numberingChange")
STORY_SUFFIXES = ("officeDocument", "/header", "/footer", "/footnotes", "/endnotes", "/comments")


def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def story_parts(package, document_part: str) -> list[str]:
    stories = [document_part]
    for rel in package.rels_for(document_part):
        if "resolved" in rel and rel["type"].endswith(STORY_SUFFIXES[1:]):
            stories.append(rel["resolved"])
    return stories


def scan_revisions(package, stories: list[str]) -> dict:
    by_kind: Counter = Counter()
    by_author: Counter = Counter()
    by_author_kind: dict[str, Counter] = defaultdict(Counter)
    paragraph_marks = 0
    missing_author = 0
    ids: Counter = Counter()
    for part in stories:
        root = package.root(part)
        if root is None:
            continue
        for kind in REVISION_KINDS:
            for element in root.iter(_w(kind)):
                author = element.get(_w("author"))
                if author is None:
                    missing_author += 1
                    author = "(none)"
                by_kind[kind] += 1
                by_author[author] += 1
                by_author_kind[author][kind] += 1
                rev_id = element.get(_w("id"))
                if rev_id is not None:
                    ids[(part, rev_id)] += 1
                parent = element.getparent()
                if kind in ("ins", "del", "moveFrom", "moveTo") and parent is not None and parent.tag == _w("rPr"):
                    paragraph_marks += 1
    duplicate_ids = sorted({rev_id for (_, rev_id), count in ids.items() if count > 1})
    return {
        "total": sum(by_kind.values()),
        "byKind": dict(sorted(by_kind.items())),
        "byAuthor": dict(sorted(by_author.items())),
        "byAuthorKind": {a: dict(sorted(k.items())) for a, k in sorted(by_author_kind.items())},
        "paragraphMarkRevisions": paragraph_marks,
        "missingAuthor": missing_author,
        "duplicateIds": duplicate_ids,
    }


def scan_comments(package, document_part: str) -> dict:
    comments_part = extended_part = None
    for rel in package.rels_for(document_part):
        if "resolved" not in rel:
            continue
        if rel["type"].endswith("/comments"):
            comments_part = rel["resolved"]
        elif rel["type"].endswith("/commentsExtended"):
            extended_part = rel["resolved"]
    result = {"count": 0, "replies": 0, "authors": [], "referencedIds": [], "unreferencedIds": [],
              "danglingReferences": []}
    document = package.root(document_part)
    referenced = sorted({el.get(_w("id")) for el in document.iter(_w("commentReference"))}, key=str)
    result["referencedIds"] = referenced
    if comments_part is None:
        result["danglingReferences"] = referenced
        return result
    root = package.root(comments_part)
    comments = root.findall("w:comment", NS)
    ids = [c.get(_w("id")) for c in comments]
    result["count"] = len(comments)
    result["authors"] = sorted({c.get(_w("author"), "") for c in comments})
    result["unreferencedIds"] = sorted(set(ids) - set(referenced), key=str)
    result["danglingReferences"] = sorted(set(referenced) - set(ids), key=str)
    if extended_part is not None:
        ext = package.root(extended_part)
        result["replies"] = sum(1 for el in ext.iter(f"{{{W15}}}commentEx") if el.get(f"{{{W15}}}paraIdParent"))
    return result


def paragraph_text(paragraph) -> str:
    out: list[str] = []
    for el in paragraph.iter():
        if el.tag in (_w("t"), _w("delText")):
            out.append(el.text or "")
        elif el.tag == _w("tab"):
            out.append("\t")
        elif el.tag in (_w("br"), _w("cr")):
            out.append("\n")
    return "".join(out)


def scan_document(package, document_part: str) -> dict:
    root = package.root(document_part)
    body = root.find("w:body", NS)
    if body is None:
        raise PackageError(f"{document_part} has no <w:body>")
    all_paragraphs = list(body.iter(_w("p")))
    styles = Counter()
    for p in all_paragraphs:
        style = p.find("w:pPr/w:pStyle", NS)
        if style is not None:
            styles[style.get(_w("val"))] += 1
    fields = [el.text.strip() for el in root.iter(_w("instrText")) if el.text and el.text.strip()]
    fields += [el.get(_w("instr")).strip() for el in root.iter(_w("fldSimple"))]
    numbered = sum(1 for p in all_paragraphs if p.find("w:pPr/w:numPr", NS) is not None)
    return {
        "bodyParagraphs": len(body.findall("w:p", NS)),
        "allParagraphs": len(all_paragraphs),
        "tables": len(list(body.iter(_w("tbl")))),
        "numberedParagraphs": numbered,
        "paragraphStyles": dict(sorted(styles.items())),
        "hyperlinks": len(list(root.iter(_w("hyperlink")))),
        "bookmarks": sorted(el.get(_w("name"), "") for el in root.iter(_w("bookmarkStart"))),
        "fields": fields,
        "footnoteReferences": len(list(root.iter(_w("footnoteReference")))),
        "characters": sum(len(paragraph_text(p)) for p in all_paragraphs),
    }


def count_related(package, document_part: str, suffix: str, element: str, skip_types=()) -> int:
    total = 0
    for rel in package.rels_for(document_part):
        if "resolved" in rel and rel["type"].endswith(suffix):
            root = package.root(rel["resolved"])
            if element is None:
                total += 1
            else:
                total += sum(1 for el in root.findall(f"w:{element}", NS) if el.get(_w("type")) not in skip_types)
    return total


def validate(path: str) -> dict:
    package = load_package(path)
    document_part = main_part(package, "/officeDocument")
    if not package.content_types.get(document_part, "").startswith(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    ) and "macroEnabled" not in package.content_types.get(document_part, ""):
        raise PackageError(f"main part {document_part} has content type {package.content_types.get(document_part)}")

    try:
        import docx  # python-docx, used as a second independent reader
        document = docx.Document(path)
    except Exception as exc:  # noqa: BLE001 - any reader failure means the file is invalid
        raise PackageError(f"python-docx could not open the file: {type(exc).__name__}: {exc}") from exc

    summary = scan_document(package, document_part)
    summary["pythonDocx"] = {
        "paragraphs": len(document.paragraphs),
        "tables": len(document.tables),
        "sections": len(document.sections),
        "headings": [p.text for p in document.paragraphs if p.style is not None and p.style.name.startswith(("Heading", "Title"))],
    }
    stories = story_parts(package, document_part)
    revisions = scan_revisions(package, stories)
    comments = scan_comments(package, document_part)
    errors: list[str] = []
    if revisions["missingAuthor"]:
        errors.append(f"{revisions['missingAuthor']} revision element(s) have no w:author")
    if revisions["duplicateIds"]:
        errors.append(f"duplicate revision ids: {', '.join(revisions['duplicateIds'][:10])}")
    if comments["danglingReferences"]:
        errors.append(f"comment references without a comment: {', '.join(comments['danglingReferences'])}")
    return {
        "file": Path(path).name,
        "valid": not errors,
        "errors": errors,
        "parts": len(package.parts),
        "document": summary,
        "revisions": revisions,
        "comments": comments,
        "footnotes": count_related(package, document_part, "/footnotes", "footnote",
                                   ("separator", "continuationSeparator", "continuationNotice")),
        "headers": count_related(package, document_part, "/header", None),
        "footers": count_related(package, document_part, "/footer", None),
    }


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        result = validate(args[0])
    except PackageError as exc:
        result = {"file": Path(args[0]).name, "valid": False, "errors": [str(exc)]}
    if "--quiet" not in argv:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result["valid"]:
        print(f"INVALID {args[0]}: {'; '.join(result['errors'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
