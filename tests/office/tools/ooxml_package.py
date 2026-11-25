"""Shared Open Packaging Convention (OPC) checks for the office fixture validators.

Independent of the Matrix OS document engine: it reads the ZIP with the standard
library and parses every XML part with lxml in a hardened mode (no DTD loading,
no entity expansion, no network access).
"""

from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote

from lxml import etree

MAX_ENTRIES = 2000
MAX_ENTRY_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024

CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

XML_PARSER = etree.XMLParser(
    resolve_entities=False,
    no_network=True,
    load_dtd=False,
    dtd_validation=False,
    huge_tree=False,
)


class PackageError(Exception):
    """The file is not a valid OPC package. The message is the reason."""


@dataclass
class Package:
    path: str
    parts: dict[str, bytes] = field(default_factory=dict)
    xml: dict[str, etree._Element] = field(default_factory=dict)
    content_types: dict[str, str] = field(default_factory=dict)
    relationships: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def root(self, name: str) -> etree._Element | None:
        return self.xml.get(name)

    def rels_for(self, part: str) -> list[dict[str, str]]:
        return self.relationships.get(rels_name_for(part), [])

    def resolve_target(self, source_part: str, target: str) -> str:
        return resolve_target(source_part, target)


def rels_name_for(part: str) -> str:
    directory, base = posixpath.split(part)
    return posixpath.join(directory, "_rels", f"{base}.rels") if directory else f"_rels/{base}.rels"


def source_for_rels(rels_name: str) -> str:
    directory, base = posixpath.split(rels_name)
    parent = posixpath.dirname(directory)
    source = base[: -len(".rels")]
    return posixpath.join(parent, source) if parent else source


def resolve_target(source_part: str, target: str) -> str:
    target = unquote(target.split("#", 1)[0])
    if target.startswith("/"):
        resolved = posixpath.normpath(target.lstrip("/"))
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))
    return "" if resolved == "." else resolved


def _is_xml_part(name: str, content_type: str | None) -> bool:
    if name.endswith((".xml", ".rels", ".vml")):
        return True
    return bool(content_type and (content_type.endswith("+xml") or content_type.endswith("/xml")))


def _parse_xml(name: str, data: bytes) -> etree._Element:
    try:
        tree = etree.fromstring(data, XML_PARSER).getroottree()
    except etree.XMLSyntaxError as exc:
        raise PackageError(f"part {name} is not well-formed XML: {exc}") from exc
    if tree.docinfo.doctype:
        raise PackageError(f"part {name} declares a DTD, which OOXML forbids")
    return tree.getroot()


def _read_zip(path: str) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise PackageError(f"not a ZIP package: {exc}") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise PackageError(f"too many ZIP entries ({len(infos)} > {MAX_ENTRIES})")
        total = 0
        parts: dict[str, bytes] = {}
        seen_lower: set[str] = set()
        for info in infos:
            if info.is_dir():
                continue
            name = info.filename
            if name.startswith("/") or ".." in name.split("/") or "\\" in name:
                raise PackageError(f"unsafe ZIP entry name: {name!r}")
            if name.lower() in seen_lower:
                raise PackageError(f"duplicate part name (case-insensitive): {name}")
            seen_lower.add(name.lower())
            if info.file_size > MAX_ENTRY_BYTES:
                raise PackageError(f"ZIP entry {name} is too large ({info.file_size} bytes)")
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise PackageError("ZIP package expands beyond the total size limit")
            try:
                parts[name] = archive.read(info)
            except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
                raise PackageError(f"ZIP entry {name} cannot be read: {exc}") from exc
        return parts


def _content_type_for(name: str, defaults: dict[str, str], overrides: dict[str, str]) -> str | None:
    if name.lower() in overrides:
        return overrides[name.lower()]
    base = posixpath.basename(name)
    extension = base.rsplit(".", 1)[1].lower() if "." in base else ""
    return defaults.get(extension)


def load_package(path: str) -> Package:
    """Read and verify an OPC package. Raises PackageError with the first fatal problem."""
    package = Package(path=path, parts=_read_zip(path))
    parts = package.parts
    if "[Content_Types].xml" not in parts:
        raise PackageError("missing [Content_Types].xml")

    ct_root = _parse_xml("[Content_Types].xml", parts["[Content_Types].xml"])
    if ct_root.tag != f"{{{CT_NS}}}Types":
        raise PackageError("[Content_Types].xml root is not <Types>")
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for element in ct_root:
        if element.tag == f"{{{CT_NS}}}Default":
            defaults[element.get("Extension", "").lower()] = element.get("ContentType", "")
        elif element.tag == f"{{{CT_NS}}}Override":
            part_name = element.get("PartName", "")
            overrides[part_name.lstrip("/").lower()] = element.get("ContentType", "")

    lower_names = {name.lower() for name in parts}
    for override in overrides:
        if override not in lower_names:
            raise PackageError(f"[Content_Types].xml overrides /{override}, which is not in the package")

    for name, data in parts.items():
        if name == "[Content_Types].xml":
            continue
        content_type = _content_type_for(name, defaults, overrides)
        if not content_type:
            raise PackageError(f"part {name} has no content type in [Content_Types].xml")
        package.content_types[name] = content_type
        if _is_xml_part(name, content_type):
            package.xml[name] = _parse_xml(name, data)

    if "_rels/.rels" not in parts:
        raise PackageError("missing package relationships _rels/.rels")

    for name in parts:
        if not name.endswith(".rels"):
            continue
        source = source_for_rels(name)
        if name != "_rels/.rels" and source not in parts:
            raise PackageError(f"relationship part {name} belongs to missing part {source}")
        root = package.xml[name]
        entries: list[dict[str, str]] = []
        ids: set[str] = set()
        for rel in root.findall(f"{{{REL_NS}}}Relationship"):
            rel_id = rel.get("Id", "")
            if not rel_id or rel_id in ids:
                raise PackageError(f"relationship part {name} has a missing or duplicate Id {rel_id!r}")
            ids.add(rel_id)
            entry = {
                "id": rel_id,
                "type": rel.get("Type", ""),
                "target": rel.get("Target", ""),
                "mode": rel.get("TargetMode", "Internal"),
            }
            if entry["mode"] != "External":
                resolved = resolve_target(source if name != "_rels/.rels" else "", entry["target"])
                if resolved not in parts:
                    raise PackageError(
                        f"relationship {rel_id} in {name} targets missing part {entry['target']}"
                    )
                entry["resolved"] = resolved
            entries.append(entry)
        package.relationships[name] = entries
    return package


def main_part(package: Package, rel_type_suffix: str) -> str:
    for rel in package.relationships.get("_rels/.rels", []):
        if rel["type"].endswith(rel_type_suffix) and "resolved" in rel:
            return rel["resolved"]
    raise PackageError(f"package has no main part relationship ending in {rel_type_suffix}")
