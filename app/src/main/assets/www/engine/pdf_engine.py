#!/usr/bin/env python3
"""Local PDF cleaner engine (shared with the desktop tool; runs in-browser via Pyodide).

This tool edits a copy of the input file. Redactions are permanent. Use only on
PDFs you are allowed to modify, and inspect the output before relying on it.
"""
from __future__ import annotations

import os
import re
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple

try:
    import pymupdf as fitz  # PyMuPDF (current import name)
except ImportError:
    try:
        import fitz  # PyMuPDF (legacy import name)
    except ImportError:
        fitz = None

APP_TITLE = "PDF Cleaner for Data Extraction"


@dataclass
class CleanOptions:
    remove_metadata: bool = True
    top_percent: float = 0.0
    bottom_percent: float = 2.0
    watermark_phrases: List[str] = None  # type: ignore[assignment]
    header_phrases: List[str] = None  # type: ignore[assignment]
    footer_phrases: List[str] = None  # type: ignore[assignment]
    custom_regions: List[Tuple[float, float, float, float]] = None  # type: ignore[assignment]
    remove_image_watermarks: bool = True
    image_watermark_xrefs: List[int] = None  # type: ignore[assignment]
    remove_annotations: bool = False
    remove_links: bool = False
    remove_attachments_js: bool = False
    remove_hidden_text: bool = False

    def __post_init__(self) -> None:
        if self.watermark_phrases is None:
            self.watermark_phrases = []
        if self.header_phrases is None:
            self.header_phrases = []
        if self.footer_phrases is None:
            self.footer_phrases = []
        if self.custom_regions is None:
            self.custom_regions = []
        if self.image_watermark_xrefs is None:
            self.image_watermark_xrefs = []


def parse_phrases(raw: str) -> List[str]:
    """Parse literal watermark phrases separated by semicolons or newlines."""
    phrases = [item.strip() for item in re.split(r"[;\n]+", raw) if item.strip()]
    # Keep unique phrases but preserve the user's order.
    return list(dict.fromkeys(phrases))


def parse_regions(raw: str) -> List[Tuple[float, float, float, float]]:
    """Parse x0,y0,x1,y1 rectangles using page percentages from top-left."""
    regions: List[Tuple[float, float, float, float]] = []
    for index, item in enumerate([part.strip() for part in raw.split(";") if part.strip()], 1):
        try:
            values = [float(value.strip()) for value in item.split(",")]
        except ValueError as exc:
            raise ValueError(
                f"Custom area {index} must contain four numbers, like 10,20,90,40."
            ) from exc
        if len(values) != 4:
            raise ValueError(
                f"Custom area {index} must contain four numbers, like 10,20,90,40."
            )
        x0, y0, x1, y1 = values
        if not all(0 <= v <= 100 for v in values):
            raise ValueError(f"Custom area {index}: each percentage must be between 0 and 100.")
        if x0 >= x1 or y0 >= y1:
            raise ValueError(f"Custom area {index}: x0 must be less than x1 and y0 less than y1.")
        regions.append((x0, y0, x1, y1))
    return regions


def parse_image_xrefs(raw: str) -> List[int]:
    """Parse manually selected PDF image object IDs, separated by comma/semicolon/newline."""
    values: List[int] = []
    for item in re.split(r"[;,\n]+", raw):
        item = item.strip()
        if not item:
            continue
        if not item.isdigit() or int(item) <= 0:
            raise ValueError(f"Image XRef ID {item!r} must be a positive whole number.")
        values.append(int(item))
    return list(dict.fromkeys(values))


def _image_soft_mask_xref(doc, image_xref: int) -> int:
    """Return the soft-mask image XRef used by an image object, if available."""
    try:
        kind, value = doc.xref_get_key(image_xref, "SMask")
        if kind == "xref":
            match = re.match(r"\s*(\d+)\s+\d+\s+R", value)
            if match:
                return int(match.group(1))
    except Exception:
        pass
    return 0


def _soft_mask_mean_opacity(doc, image_xref: int) -> Optional[float]:
    """Estimate alpha-mask opacity (0-255), sampling at most about 50k pixels."""
    mask_xref = _image_soft_mask_xref(doc, image_xref)
    if not mask_xref:
        return None
    pix = None
    try:
        pix = fitz.Pixmap(doc, mask_xref)
        samples = pix.samples
        if not samples:
            return None
        stride = max(1, len(samples) // 50000)
        sampled = samples[::stride]
        return sum(sampled) / len(sampled)
    except Exception:
        return None
    finally:
        pix = None


def _collect_image_inventory(doc) -> dict:
    """Collect visible image XRefs, page placements, dimensions, and mask data."""
    inventory = {}
    for page_index in range(len(doc)):
        page = doc[page_index]
        page_rect = page.rect
        page_area = max(1.0, page_rect.width * page_rect.height)
        try:
            infos = page.get_image_info(xrefs=True)
        except Exception:
            infos = []
        for info in infos:
            try:
                xref = int(info.get("xref") or 0)
            except (TypeError, ValueError):
                xref = 0
            if xref <= 0:
                continue
            try:
                image_rect = fitz.Rect(info.get("bbox", page_rect)) & page_rect
                coverage = max(0.0, image_rect.width * image_rect.height) / page_area
            except Exception:
                coverage = 0.0
            record = inventory.setdefault(xref, {
                "xref": xref,
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "has_mask": False,
                "pages": set(),
                "page_indices": set(),
                "max_coverage": 0.0,
                "mask_mean": None,
            })
            record["has_mask"] = bool(record["has_mask"] or info.get("has-mask", False))
            record["pages"].add(page_index + 1)
            record["page_indices"].add(page_index)
            record["max_coverage"] = max(record["max_coverage"], coverage)
    for xref, record in inventory.items():
        if record["has_mask"]:
            record["mask_mean"] = _soft_mask_mean_opacity(doc, xref)
    return inventory


def _likely_image_watermark_xrefs(inventory: dict) -> List[int]:
    """Find large, mostly transparent images that plausibly act as watermark layers.

    To avoid deleting normal photographs or scanned pages, this automatic mode requires
    an alpha/soft mask, a low mean mask opacity, adequate image resolution, and a large
    page placement. Other image XRefs can be targeted explicitly by the user.
    """
    candidates = []
    for xref, item in inventory.items():
        width, height = item["width"], item["height"]
        mask_mean = item.get("mask_mean")
        if not item["has_mask"] or mask_mean is None:
            continue
        if width < 100 or height < 60 or width * height < 20000:
            continue
        if item["max_coverage"] < 0.12:
            continue
        if mask_mean <= 220:
            candidates.append(int(xref))
    return sorted(candidates)


def open_pdf(path: str, password: str = ""):
    """Open a PDF, authenticating first when it is password-protected."""
    if fitz is None:
        raise RuntimeError("PyMuPDF is not installed. Install dependencies using: python -m pip install -r requirements.txt")
    doc = fitz.open(path)
    if doc.needs_pass:
        if not password:
            doc.close()
            raise RuntimeError(
                "This PDF is password-protected. Enter the correct password in the 'PDF password' field."
            )
        try:
            authenticated = doc.authenticate(password)
        except Exception:
            authenticated = 0
        if not authenticated:
            doc.close()
            raise RuntimeError("The PDF password is incorrect, or the document requires a different password.")
    return doc


def text_char_count(doc) -> int:
    total = 0
    for page in doc:
        try:
            total += len(page.get_text("text"))
        except Exception:
            pass
    return total


_SEP_TOKENS = set("|Il1!\u00a6/\\")
_LOOSE_MAP = str.maketrans({"i": "l"})


def _loose_tokens(text: str) -> List[str]:
    out = []
    for tok in text.split():
        if tok in _SEP_TOKENS:
            continue
        norm = "".join(ch for ch in tok.casefold() if ch.isalnum())
        if norm:
            out.append(norm)
    return out


def _loose_key(text: str) -> str:
    """Case, spacing, symbols and digits are ignored (digits become #, i/l/1 look alike)."""
    return re.sub(r"\d", "#", text.translate(_LOOSE_MAP))


def _zone_ok(page, rect, location: str) -> bool:
    page_rect = page.rect
    center_y = (rect.y0 + rect.y1) / 2
    if location == "header":
        return center_y <= page_rect.y0 + page_rect.height * 0.25
    if location == "footer":
        return center_y >= page_rect.y1 - page_rect.height * 0.25
    return True


def _fuzzy_zone_hits(page, phrase: str, location: str):
    """Find header/footer text that is similar to the phrase: other spacing, symbols such as |,
    upper/lower case, wrapped lines, or different numbers. Returns [(rect, matched_text)]."""
    import bisect
    import difflib
    query = _loose_key("".join(_loose_tokens(phrase)))
    if len(query) < 4:
        return []
    try:
        raw = page.get_text("words")
    except Exception:
        return []
    words = []
    for w in raw:
        try:
            rect = fitz.Rect(w[0], w[1], w[2], w[3])
            if not _zone_ok(page, rect, location):
                continue
            toks = _loose_tokens(str(w[4]))
            if not toks:
                continue
            words.append((int(w[5]), int(w[6]), int(w[7]), rect, str(w[4]), _loose_key("".join(toks))))
        except Exception:
            continue
    words.sort(key=lambda x: (x[0], x[1], x[2]))
    words = words[:400]
    if not words:
        return []
    keys = [w[5] for w in words]
    starts, pos = [], 0
    for k in keys:
        starts.append(pos)
        pos += len(k)
    joined = "".join(keys)

    spans = []  # (first_word, last_word)
    at = joined.find(query)
    while at >= 0:
        first = bisect.bisect_right(starts, at) - 1
        last = bisect.bisect_right(starts, at + len(query) - 1) - 1
        spans.append((first, last))
        at = joined.find(query, at + len(query))
    if not spans and len(query) >= 6:
        lo, hi = int(len(query) * 0.85), int(len(query) * 1.2) + 1
        cand = []
        for i in range(len(keys)):
            acc = ""
            for j in range(i, len(keys)):
                acc += keys[j]
                if len(acc) > hi:
                    break
                if len(acc) < lo:
                    continue
                sm = difflib.SequenceMatcher(None, query, acc, autojunk=False)
                if sm.real_quick_ratio() < 0.82 or sm.quick_ratio() < 0.82:
                    continue
                ratio = sm.ratio()
                if ratio >= 0.82:
                    cand.append((ratio, i, j))
        used = set()
        for ratio, i, j in sorted(cand, reverse=True):
            if any(k in used for k in range(i, j + 1)):
                continue
            used.update(range(i, j + 1))
            spans.append((i, j))
    hits = []
    for first, last in spans:
        group = None
        for idx in range(first, last + 1):
            blk, line, _, rect, text, _ = words[idx]
            if group and group[0] == (blk, line):
                group[1] |= rect
                group[2].append(text)
            else:
                if group:
                    hits.append((group[1], " ".join(group[2])))
                group = [(blk, line), fitz.Rect(rect), [text]]
        if group:
            hits.append((group[1], " ".join(group[2])))
    return hits


def phrase_hits(page, phrase: str, location: str = "any"):
    """[(rect, text_to_guard)]: exact matches first; for header/footer also similar text."""
    try:
        quads = page.search_for(phrase, quads=True)
    except Exception:
        quads = []
    hits = [(q.rect, phrase) for q in quads if _zone_ok(page, q.rect, location)]
    if hits or location == "any":
        return hits
    return _fuzzy_zone_hits(page, phrase, location)


def find_phrase_rects(page, phrase: str, location: str = "any"):
    """Phrase matches, limited to the top/bottom 25% of the page for header/footer phrases."""
    return [rect for rect, _ in phrase_hits(page, phrase, location)]


def _normalize_phrase_text(value: str) -> str:
    """Normalize phrase text for conservative matching in PDF text objects."""
    return "".join(char.casefold() for char in value if char.isalnum())


def _skip_literal_string(data: bytes, start: int) -> Tuple[bytes, int]:
    """Read and unescape one PDF literal string starting at an opening parenthesis."""
    result = bytearray()
    index = start + 1
    depth = 1
    escapes = {
        ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8,
        ord("f"): 12, ord("("): 40, ord(")"): 41, ord("\\"): 92,
    }
    while index < len(data):
        current = data[index]
        if current == 92:  # backslash escape
            index += 1
            if index >= len(data):
                break
            escaped = data[index]
            if escaped in (10, 13):  # line continuation
                if escaped == 13 and index + 1 < len(data) and data[index + 1] == 10:
                    index += 1
                index += 1
                continue
            if 48 <= escaped <= 55:  # one-to-three digit octal escape
                digits = bytearray([escaped])
                for _ in range(2):
                    if index + 1 < len(data) and 48 <= data[index + 1] <= 55:
                        index += 1
                        digits.append(data[index])
                    else:
                        break
                result.append(int(digits.decode("ascii"), 8) & 0xFF)
            else:
                result.append(escapes.get(escaped, escaped))
            index += 1
            continue
        if current == 40:  # nested opening parenthesis belongs to the string
            depth += 1
            result.append(current)
            index += 1
            continue
        if current == 41:
            depth -= 1
            index += 1
            if depth == 0:
                return bytes(result), index
            result.append(current)
            continue
        result.append(current)
        index += 1
    return bytes(result), index


def _pdf_tokens(data: bytes):
    """Yield basic PDF content tokens without interpreting strings as operators."""
    whitespace = b"\x00\x09\x0a\x0c\x0d\x20"
    delimiters = b"()<>[]{}/%"
    index = 0
    length = len(data)
    while index < length:
        byte = data[index]
        if byte in whitespace:
            index += 1
            continue
        if byte == 37:  # comment
            newline = data.find(b"\n", index + 1)
            index = length if newline < 0 else newline + 1
            continue
        start = index
        if byte == 40:  # literal string
            value, index = _skip_literal_string(data, index)
            yield ("string", value, start, index)
            continue
        if byte == 60:  # hex string or dictionary opener
            if index + 1 < length and data[index + 1] == 60:
                index += 2
                yield ("delimiter", b"<<", start, index)
                continue
            end = data.find(b">", index + 1)
            if end < 0:
                end = length
            raw_hex = re.sub(rb"\s+", b"", data[index + 1:end])
            if len(raw_hex) % 2:
                raw_hex += b"0"
            try:
                value = bytes.fromhex(raw_hex.decode("ascii"))
            except Exception:
                value = b""
            index = min(end + 1, length)
            yield ("string", value, start, index)
            continue
        if byte == 62 and index + 1 < length and data[index + 1] == 62:
            index += 2
            yield ("delimiter", b">>", start, index)
            continue
        if byte in b"[]{}":
            index += 1
            yield ("delimiter", bytes([byte]), start, index)
            continue
        if byte == 47:  # PDF name: skip the whole name, not any letters within it
            index += 1
            while index < length and data[index] not in whitespace + delimiters:
                index += 1
            yield ("name", data[start:index], start, index)
            continue
        while index < length and data[index] not in whitespace + delimiters:
            index += 1
        if index == start:
            index += 1
            yield ("other", data[start:index], start, index)
        else:
            yield ("word", data[start:index], start, index)


def _text_object_spans(content: bytes) -> List[Tuple[int, int, bytes]]:
    """Locate BT...ET text objects while ignoring occurrences inside strings/comments."""
    spans: List[Tuple[int, int, bytes]] = []
    start = None
    body_start = None
    for kind, value, token_start, token_end in _pdf_tokens(content):
        if kind != "word":
            continue
        if value == b"BT":
            start = token_start
            body_start = token_end
        elif value == b"ET" and start is not None and body_start is not None:
            spans.append((start, token_end, content[body_start:token_start]))
            start = None
            body_start = None
    return spans


def _shown_strings_in_text_object(body: bytes) -> List[bytes]:
    """Extract strings passed to PDF text-show operators inside one BT...ET object."""
    pending: List[Tuple[str, bytes]] = []
    shown: List[bytes] = []
    text_show_ops = {b"Tj", b"TJ", b"'", b'"'}
    for kind, value, _, _ in _pdf_tokens(body):
        if kind == "string":
            pending.append((kind, value))
            continue
        if kind in ("delimiter", "name", "other"):
            pending.append((kind, value))
            continue
        if kind == "word":
            is_operator = bool(re.fullmatch(rb"[A-Za-z]+|['\"]", value))
            if is_operator:
                if value in text_show_ops:
                    shown.extend(token_value for token_kind, token_value in pending if token_kind == "string")
                pending = []
            else:
                pending.append((kind, value))
    return shown


def _text_strings_match_phrase(strings: List[bytes], phrase: str) -> bool:
    """Check whether all text-show strings in an object represent just one phrase."""
    target = _normalize_phrase_text(phrase)
    if not target or not strings:
        return False
    encodings = ("utf-16-be", "utf-16-le", "utf-8-sig", "cp1252", "latin-1")
    candidates: List[str] = []
    joined = b"".join(strings)
    for encoding in encodings:
        try:
            candidates.append(joined.decode(encoding, errors="ignore"))
        except Exception:
            pass
        try:
            candidates.append("".join(part.decode(encoding, errors="ignore") for part in strings))
        except Exception:
            pass
    return any(_normalize_phrase_text(candidate) == target for candidate in candidates)


def remove_standalone_watermark_text_objects(page, phrases: List[str]) -> int:
    """Remove a standalone watermark text object directly from the PDF content stream.

    This avoids drawing a redaction rectangle over a watermark, which can erase
    unrelated text underneath a rotated / diagonal watermark. Only objects whose
    displayed text is exactly one of the requested watermark phrases are removed.
    """
    phrases = [phrase for phrase in phrases if _normalize_phrase_text(phrase)]
    if not phrases:
        return 0
    try:
        content = page.read_contents()
    except Exception:
        return 0
    if not content:
        return 0

    removals: List[Tuple[int, int]] = []
    for start, end, body in _text_object_spans(content):
        shown = _shown_strings_in_text_object(body)
        if shown and any(_text_strings_match_phrase(shown, phrase) for phrase in phrases):
            removals.append((start, end))

    if not removals:
        return 0

    updated = bytearray()
    cursor = 0
    for start, end in removals:
        updated.extend(content[cursor:start])
        updated.extend(b"\n")
        cursor = end
    updated.extend(content[cursor:])

    try:
        document = page.parent
        new_xref = document.get_new_xref()
        document.update_object(new_xref, "<<>>")
        document.update_stream(new_xref, bytes(updated))
        page.set_contents(new_xref)
        return len(removals)
    except Exception:
        # Leave the page unchanged if its content stream cannot be safely rewritten.
        return 0


def _rect_overlaps_other_content(page, rect, phrase: str, check_graphics: bool = True) -> bool:
    """Return True if a redaction rectangle would also intersect other page content."""
    target_tokens = {_normalize_phrase_text(token) for token in re.findall(r"[\w]+", phrase, flags=re.UNICODE)}
    target_tokens.discard("")
    joined_phrase = _normalize_phrase_text(phrase)
    try:
        words = page.get_text("words")
    except Exception:
        return False
    for word in words:
        try:
            word_rect = fitz.Rect(word[0], word[1], word[2], word[3])
            word_text = str(word[4])
        except Exception:
            continue
        if not rect.intersects(word_rect):
            continue
        if word_text.strip() in _SEP_TOKENS:
            continue
        norm_word = _normalize_phrase_text(word_text)
        if not norm_word or norm_word in target_tokens or (len(norm_word) >= 3 and norm_word in joined_phrase):
            continue
        return True

    if not check_graphics:
        return False
    # A white redaction rectangle can cover artwork even when image / graphics
    # redaction modes are disabled, so avoid it when unrelated drawings or images
    # share the target's bounding box.
    try:
        for drawing in page.get_drawings():
            drawing_rect = drawing.get("rect")
            if drawing_rect and rect.intersects(fitz.Rect(drawing_rect)):
                return True
    except Exception:
        pass
    try:
        seen_xrefs = set()
        for image_info in page.get_images(full=True):
            image_xref = image_info[0]
            if image_xref in seen_xrefs:
                continue
            seen_xrefs.add(image_xref)
            for image_rect in page.get_image_rects(image_xref):
                if rect.intersects(fitz.Rect(image_rect)):
                    return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Hidden / tracker text detection
# ---------------------------------------------------------------------------
_TINY_FONT_PT = 2.0          # text smaller than this is not human-readable
_FLAT_RANGE = 24             # luminance spread (0-255) under which a region shows nothing


def _span_text(span) -> str:
    out = []
    for ch in span.get("chars") or []:
        try:
            out.append(chr(ch[0]) if isinstance(ch[0], int) else str(ch[0]))
        except Exception:
            pass
    return "".join(out)


def _color_luminance(color) -> float:
    try:
        if color is None:
            return 0.0
        if isinstance(color, (int, float)):
            return float(color)
        vals = list(color)
        if len(vals) == 1:
            return float(vals[0])
        if len(vals) == 3:
            return 0.299 * vals[0] + 0.587 * vals[1] + 0.114 * vals[2]
        if len(vals) == 4:  # CMYK
            c, m, y, k = vals
            return (1 - min(1, c + k)) * 0.299 + (1 - min(1, m + k)) * 0.587 + (1 - min(1, y + k)) * 0.114
    except Exception:
        pass
    return 0.0


def _region_is_flat(gray_pix, rect) -> bool:
    """True when the rendered page shows (almost) nothing inside rect, i.e. text there is not visible."""
    try:
        x0 = max(0, int(rect.x0))
        y0 = max(0, int(rect.y0))
        x1 = min(gray_pix.width, int(rect.x1) + 1)
        y1 = min(gray_pix.height, int(rect.y1) + 1)
        if x1 <= x0 or y1 <= y0:
            return True
        data = gray_pix.samples
        stride = gray_pix.stride
        lo, hi = 255, 0
        for row in range(y0, y1):
            chunk = data[row * stride + x0: row * stride + x1]
            if chunk:
                lo = min(lo, min(chunk))
                hi = max(hi, max(chunk))
        return (hi - lo) < _FLAT_RANGE
    except Exception:
        return False


def find_hidden_text(page) -> dict:
    """Classify text spans on a page that a reader cannot see.

    Returns {"hidden": [{"rect", "text", "reason"}], "visible_rects": [Rect],
             "ocr_protected": int}.
    Reasons: outside page, fully transparent, invisible render mode, microscopic
    size, or blends into the background (e.g. white on white).
    Invisible-render-mode text on a page with no other visible text is treated as
    an OCR/searchable layer and is protected (reported, never removed).
    """
    result = {"hidden": [], "visible_rects": [], "ocr_protected": 0}
    try:
        spans = page.get_texttrace()
    except Exception:
        return result
    page_rect = page.rect
    gray = None
    gray_tried = False
    hidden = []
    visible = []
    invisible_mode = []
    for span in spans:
        text = _span_text(span)
        if not text.strip():
            continue
        try:
            rect = fitz.Rect(span["bbox"])
        except Exception:
            continue
        reason = None
        invis_mode = False
        if rect.is_empty or not rect.intersects(page_rect):
            reason = "outside page"
        elif float(span.get("opacity", 1.0)) < 0.05:
            reason = "fully transparent"
        elif span.get("type") == 3:
            reason = "invisible render mode"
            invis_mode = True
        elif float(span.get("size", 12.0)) < _TINY_FONT_PT:
            reason = "microscopic size"
        elif _color_luminance(span.get("color")) > 0.8:
            if not gray_tried:
                gray_tried = True
                try:
                    gray = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csGRAY, alpha=False)
                except Exception:
                    gray = None
            if gray is not None and _region_is_flat(gray, rect):
                reason = "same color as background"
        if reason:
            item = {"rect": rect, "text": text, "reason": reason}
            hidden.append(item)
            if invis_mode:
                invisible_mode.append(item)
        else:
            visible.append(rect)
    # OCR / searchable-text layer protection.
    if invisible_mode and not visible:
        protected = {id(i) for i in invisible_mode}
        result["ocr_protected"] = len(invisible_mode)
        hidden = [h for h in hidden if id(h) not in protected]
    result["hidden"] = hidden
    result["visible_rects"] = visible
    return result


def _overlaps_visible(rect, visible_rects) -> bool:
    probe = fitz.Rect(rect)
    probe.x0 += probe.width * 0.05
    probe.x1 -= probe.width * 0.05
    probe.y0 += probe.height * 0.15
    probe.y1 -= probe.height * 0.15
    if probe.is_empty:
        probe = fitz.Rect(rect)
    return any(probe.intersects(v) for v in visible_rects)


def remove_hidden_text(page) -> Tuple[int, int, int]:
    """Remove hidden/tracker text from one page.

    Returns (removed, skipped_overlapping_visible_text, ocr_layer_spans_kept).
    Strategy: delete standalone text objects directly from the content stream
    (no collateral damage); then redact what remains, but never where it would
    also touch visible text.
    """
    info = find_hidden_text(page)
    hidden = info["hidden"]
    ocr_kept = info["ocr_protected"]
    if not hidden:
        return 0, 0, ocr_kept
    visible_norm = {_normalize_phrase_text(_text_of_rect(page, r)) for r in info["visible_rects"]}
    visible_norm.discard("")
    removed = 0

    # Pass 1: exact standalone text objects (skip phrases that also appear as visible text).
    phrases = []
    for item in hidden:
        norm = _normalize_phrase_text(item["text"])
        if len(norm) >= 3 and norm not in visible_norm:
            phrases.append(item["text"])
    if phrases:
        removed += remove_standalone_watermark_text_objects(page, list(dict.fromkeys(phrases)))

    # Pass 2: whatever is still hidden gets redacted if that cannot hit visible text.
    info = find_hidden_text(page)
    skipped = 0
    added = 0
    for item in info["hidden"]:
        if item["reason"] != "outside page" and _overlaps_visible(item["rect"], info["visible_rects"]):
            skipped += 1
            continue
        try:
            page.add_redact_annot(item["rect"], fill=False, cross_out=False)
            added += 1
        except Exception:
            pass
    if added:
        try:
            page.apply_redactions(images=0, graphics=0, text=0)
            removed += added
        except Exception:
            pass
    return removed, skipped, max(ocr_kept, info["ocr_protected"])


def _text_of_rect(page, rect) -> str:
    try:
        return page.get_text("text", clip=rect)
    except Exception:
        return ""


def count_hidden_text(doc, status: Optional[Callable[[str], None]] = None) -> Tuple[int, int, dict]:
    """(hidden span count, OCR-protected span count, {reason: count}) across the document."""
    total = 0
    ocr = 0
    reasons: dict = {}
    pages = len(doc)
    for page_no, page in enumerate(doc, start=1):
        if status and (page_no % 3 == 0 or page_no == pages):
            status(f"Checking hidden text, page {page_no} of {pages}...")
        info = find_hidden_text(page)
        ocr += info["ocr_protected"]
        for item in info["hidden"]:
            total += 1
            reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    return total, ocr, reasons


def analyze_pdf(
    path: str,
    phrases: List[str],
    password: str = "",
    header_phrases: Optional[List[str]] = None,
    footer_phrases: Optional[List[str]] = None,
    status: Optional[Callable[[str], None]] = None,
) -> str:
    doc = open_pdf(path, password)
    try:
        pages = len(doc)
        if status:
            status(f"Scanning page 1 of {pages}...")
        chars = text_char_count(doc)
        annotations = 0
        links = 0
        for page_no, page in enumerate(doc, start=1):
            if status and (page_no % 3 == 0 or page_no == pages):
                status(f"Scanning page {page_no} of {pages}...")
            try:
                annotations += sum(1 for _ in (page.annots() or []))
            except Exception:
                pass
            try:
                links += len(page.get_links())
            except Exception:
                pass
        try:
            attachments = doc.embfile_count()
        except Exception:
            attachments = 0
        metadata = doc.metadata or {}
        metadata_items = [
            f"{key}={value}" for key, value in metadata.items()
            if value and key not in ("format", "encryption")
        ]
        xmp = "present"
        try:
            if not doc.get_xml_metadata():
                xmp = "not found"
        except Exception:
            xmp = "unknown"
        phrase_lines = []
        phrase_groups = [
            ("Watermark (anywhere)", phrases or [], "any"),
            ("Header (top 25% only)", header_phrases or [], "header"),
            ("Footer (bottom 25% only)", footer_phrases or [], "footer"),
        ]
        for group_label, group_phrases, location in phrase_groups:
            for phrase in group_phrases:
                found = sum(len(find_phrase_rects(page, phrase, location)) for page in doc)
                phrase_lines.append(f"  • {phrase!r} [{group_label}]: {found} text match(es)")
        lines = [
            f"File: {Path(path).name}",
            f"Pages: {pages}",
            f"Selectable text characters: {chars:,}",
            f"Annotations/stamps: {annotations}",
            f"Hyperlinks: {links}",
            f"Embedded attachments: {attachments}",
            f"XMP metadata: {xmp}",
            f"Standard metadata fields with values: {len(metadata_items)}",
        ]
        if phrase_lines:
            lines.extend(["Configured text phrase scan:", *phrase_lines])
        hidden_total, hidden_ocr, hidden_reasons = count_hidden_text(doc, status)
        lines.append(f"Hidden/tracker text spans: {hidden_total}")
        if hidden_reasons:
            lines.append("  " + ", ".join(f"{n} {r}" for r, n in sorted(hidden_reasons.items())))
        if hidden_ocr:
            lines.append(f"  {hidden_ocr} invisible OCR/search-layer span(s) detected; these are always kept.")

        image_inventory = _collect_image_inventory(doc)
        likely_xrefs = set(_likely_image_watermark_xrefs(image_inventory))
        lines.extend([
            "",
            "Visible image-object inventory (XRef IDs can be entered for manual image-watermark removal):",
        ])
        if not image_inventory:
            lines.append("  No visible image objects with removable XRefs were found.")
        else:
            for xref, item in sorted(image_inventory.items())[:35]:
                pages_label = ",".join(str(p) for p in sorted(item["pages"]))
                mask_label = "yes" if item["has_mask"] else "no"
                mask_mean = item.get("mask_mean")
                mask_label += f", mean opacity {mask_mean:.1f}/255" if mask_mean is not None else ""
                coverage = item["max_coverage"] * 100.0
                marker = " [likely transparent watermark]" if xref in likely_xrefs else ""
                lines.append(
                    f"  XRef {xref}: {item['width']}x{item['height']} px; page(s) {pages_label}; "
                    f"alpha mask={mask_label}; largest placement={coverage:.0f}% of page{marker}"
                )
            if len(image_inventory) > 35:
                lines.append(f"  ... {len(image_inventory) - 35} more image XRef(s) omitted from this report.")
            lines.append(
                "  Automatic image-watermark removal targets large, mostly transparent image objects only. "
                "Use explicit XRef IDs for other image watermarks after identifying them."
            )

        if chars < max(30, pages * 10):
            lines.extend([
                "",
                "Heads-up: very little selectable text was found. This may be a scanned/image-only PDF;",
                "cleanup alone will not make it searchable. OCR would be needed for text extraction.",
            ])
        return "\n".join(lines)
    finally:
        doc.close()


def _page_region(page, region: Tuple[float, float, float, float]):
    x0p, y0p, x1p, y1p = region
    r = page.rect
    return fitz.Rect(
        r.x0 + r.width * x0p / 100.0,
        r.y0 + r.height * y0p / 100.0,
        r.x0 + r.width * x1p / 100.0,
        r.y0 + r.height * y1p / 100.0,
    )


def clean_pdf(
    input_path: str,
    output_path: str,
    options: CleanOptions,
    status: Optional[Callable[[str], None]] = None,
    password: str = "",
) -> str:
    """Clean one PDF and return a processing report."""
    def say(message: str) -> None:
        if status:
            status(message)

    src = Path(input_path).expanduser().resolve()
    dst = Path(output_path).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Input PDF not found: {src}")
    if src == dst:
        raise ValueError("Output path must be different from the original PDF path.")
    if dst.suffix.lower() != ".pdf":
        raise ValueError("Output filename must end in .pdf.")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if options.top_percent < 0 or options.bottom_percent < 0:
        raise ValueError("Header/footer percentages cannot be negative.")
    if options.top_percent >= 100 or options.bottom_percent >= 100:
        raise ValueError("Header/footer percentage must be less than 100.")
    if options.top_percent + options.bottom_percent >= 100:
        raise ValueError("The top and bottom bands overlap or cover the entire page. Reduce the percentages.")

    doc = open_pdf(str(src), password)
    try:
        page_count = len(doc)
        redacted_phrase_matches = 0
        redacted_header_matches = 0
        redacted_footer_matches = 0
        redacted_area_pages = 0
        watermark_objects_removed = 0
        skipped_watermark_matches = 0
        skipped_header_matches = 0
        skipped_footer_matches = 0
        hidden_removed = 0
        hidden_skipped = 0
        hidden_ocr_kept = 0

        # Snapshot visible image placements before changing page streams. Automatic
        # detection only selects large, mostly transparent images; the manual XRef
        # field lets a user explicitly select image watermarks that use other methods.
        image_inventory = (
            _collect_image_inventory(doc)
            if (options.remove_image_watermarks or options.image_watermark_xrefs) else {}
        )
        automatic_image_xrefs = (
            _likely_image_watermark_xrefs(image_inventory)
            if options.remove_image_watermarks else []
        )
        requested_image_xrefs = set(options.image_watermark_xrefs or [])
        target_image_xrefs = sorted(set(automatic_image_xrefs) | requested_image_xrefs)
        missing_image_xrefs = sorted(xref for xref in requested_image_xrefs if xref not in image_inventory)
        removed_image_xrefs: List[int] = []
        failed_image_xrefs: List[int] = []
        for image_xref in target_image_xrefs:
            item = image_inventory.get(image_xref)
            if item is None:
                continue
            try:
                first_page_index = min(item["page_indices"])
                doc[first_page_index].delete_image(image_xref)
                removed_image_xrefs.append(image_xref)
            except Exception:
                failed_image_xrefs.append(image_xref)

        say(
            f"Opened {src.name} ({page_count} pages). "
            f"Image watermark layer(s) removed: {len(removed_image_xrefs)}. Preparing clean copy..."
        )

        for page_index in range(page_count):
            page = doc[page_index]
            if options.remove_hidden_text:
                h_removed, h_skipped, h_ocr = remove_hidden_text(page)
                hidden_removed += h_removed
                hidden_skipped += h_skipped
                hidden_ocr_kept += h_ocr
            # Prefer deleting a standalone watermark text object from the page stream.
            # This removes the watermark without redacting a rectangle over body text.
            if options.watermark_phrases:
                watermark_objects_removed += remove_standalone_watermark_text_objects(
                    page, options.watermark_phrases
                )

            # If a phrase is still present, only use rectangle-based redaction when
            # its rectangle does not intersect other selectable text. This prevents a
            # diagonal watermark's large bounding box from deleting document content.
            phrase_jobs = (
                [("watermark", phrase, "any") for phrase in options.watermark_phrases]
                + [("header", phrase, "header") for phrase in options.header_phrases]
                + [("footer", phrase, "footer") for phrase in options.footer_phrases]
            )
            matched_rects = {}
            skipped_here = set()
            for category, phrase, location in phrase_jobs:
                for rect, guard_text in phrase_hits(page, phrase, location):
                    key = tuple(round(value, 2) for value in (rect.x0, rect.y0, rect.x1, rect.y1))
                    if _rect_overlaps_other_content(page, rect, guard_text, check_graphics=(category == "watermark")):
                        skip_key = (category, key)
                        if skip_key not in skipped_here:
                            skipped_here.add(skip_key)
                            if category == "watermark":
                                skipped_watermark_matches += 1
                            elif category == "header":
                                skipped_header_matches += 1
                            else:
                                skipped_footer_matches += 1
                        continue
                    if key not in matched_rects:
                        matched_rects[key] = (rect, set())
                    matched_rects[key][1].add(category)

            phrase_matches_on_page = 0
            page_watermark_matches = 0
            page_header_matches = 0
            page_footer_matches = 0
            for rect, categories in matched_rects.values():
                try:
                    page.add_redact_annot(rect, fill=(1, 1, 1) if (categories - {"header", "footer"}) else False, cross_out=False)
                    phrase_matches_on_page += 1
                    if "watermark" in categories:
                        page_watermark_matches += 1
                    if "header" in categories:
                        page_header_matches += 1
                    if "footer" in categories:
                        page_footer_matches += 1
                except Exception:
                    pass
            if phrase_matches_on_page:
                page.apply_redactions(images=0, graphics=0, text=0)
                redacted_phrase_matches += page_watermark_matches
                redacted_header_matches += page_header_matches
                redacted_footer_matches += page_footer_matches

            # Then remove selected bands/areas, including overlapping image and vector
            # artwork, so image/vector watermarks can be removed when the user selects
            # an appropriate custom region. This is intentionally destructive in-area.
            area_rects = []
            page_rect = page.rect
            if options.top_percent > 0:
                area_rects.append(fitz.Rect(
                    page_rect.x0, page_rect.y0, page_rect.x1,
                    page_rect.y0 + page_rect.height * options.top_percent / 100.0,
                ))
            if options.bottom_percent > 0:
                area_rects.append(fitz.Rect(
                    page_rect.x0,
                    page_rect.y1 - page_rect.height * options.bottom_percent / 100.0,
                    page_rect.x1,
                    page_rect.y1,
                ))
            for region in options.custom_regions:
                area_rects.append(_page_region(page, region))
            for rect in area_rects:
                try:
                    page.add_redact_annot(rect, fill=(1, 1, 1), cross_out=False)
                except Exception:
                    pass
            if area_rects:
                page.apply_redactions(images=2, graphics=2, text=0)
                redacted_area_pages += 1

            if True:
                say(f"Processing page {page_index + 1} of {page_count}...")

        # Metadata cleanup is separate from page-content redaction.
        if options.remove_metadata:
            say("Removing standard and XML metadata...")
            try:
                doc.set_metadata({
                    "title": "", "author": "", "subject": "", "keywords": "",
                    "creator": "", "producer": "", "creationDate": "",
                    "modDate": "", "trapped": "",
                })
            except Exception:
                # Fallback for PDFs with unusual metadata dictionaries.
                doc.set_metadata({})
            try:
                doc.del_xml_metadata()
            except Exception:
                try:
                    doc.set_xml_metadata("")
                except Exception:
                    pass

        if options.remove_annotations:
            say("Removing page annotations and stamps...")
            for page in doc:
                try:
                    annots = list(page.annots() or [])
                except Exception:
                    annots = []
                for annot in annots:
                    try:
                        page.delete_annot(annot)
                    except Exception:
                        pass

        if options.remove_links:
            say("Removing page hyperlinks...")
            for page in doc:
                try:
                    links = list(page.get_links())
                except Exception:
                    links = []
                for link in links:
                    try:
                        page.delete_link(link)
                    except Exception:
                        pass

        if options.remove_attachments_js:
            say("Removing embedded attachments and JavaScript actions...")
            # Avoid touching page content, form values, or hyperlinks while scrubbing
            # document-level extras.
            doc.scrub(
                attached_files=True,
                clean_pages=False,
                embedded_files=True,
                hidden_text=False,
                javascript=True,
                metadata=False,
                redactions=False,
                redact_images=0,
                remove_links=False,
                reset_fields=False,
                reset_responses=False,
                thumbnails=False,
                xml_metadata=False,
            )

        say("Saving optimized output copy...")
        if dst.exists():
            dst.unlink()
        big = page_count >= 100 or src.stat().st_size >= 30 * 1024 * 1024
        doc.save(str(dst), garbage=3 if big else 4, deflate=True, clean=not big, encryption=fitz.PDF_ENCRYPT_NONE)
        if not dst.is_file() or dst.stat().st_size == 0:
            raise RuntimeError("The output PDF was not created correctly.")

        report = [
            f"Cleaned copy saved: {dst}",
            f"Pages processed: {page_count}",
            f"Standalone watermark text objects removed directly: {watermark_objects_removed}",
            f"Watermark text matches removed by safe redaction: {redacted_phrase_matches}",
            f"Watermark matches skipped to protect overlapping content: {skipped_watermark_matches}",
            f"Automatic image-watermark detection: {'On' if options.remove_image_watermarks else 'Off'}",
            f"Image XRefs removed (replaced with transparent placeholders): {', '.join(map(str, removed_image_xrefs)) if removed_image_xrefs else 'None'}",
            f"Image XRefs requested but not found as visible image objects: {', '.join(map(str, missing_image_xrefs)) if missing_image_xrefs else 'None'}",
            f"Image XRefs that could not be removed: {', '.join(map(str, failed_image_xrefs)) if failed_image_xrefs else 'None'}",
            f"Header text matches redacted (top 25% only): {redacted_header_matches}",
            f"Header matches skipped to protect overlapping content: {skipped_header_matches}",
            f"Footer text matches redacted (bottom 25% only): {redacted_footer_matches}",
            f"Footer matches skipped to protect overlapping content: {skipped_footer_matches}",
            f"Pages with band/custom-area redactions: {redacted_area_pages}",
            f"Hidden/tracker text removed: {hidden_removed if options.remove_hidden_text else 'Off'}"
            + (f" (skipped {hidden_skipped} overlapping visible text; kept {hidden_ocr_kept} OCR-layer span(s))" if options.remove_hidden_text else ""),
            f"Metadata removed: {'Yes' if options.remove_metadata else 'No'}",
            "Output encryption: Disabled (the saved PDF will not require a password)",
            f"Annotations removed: {'Yes' if options.remove_annotations else 'No'}",
            f"Hyperlinks removed: {'Yes' if options.remove_links else 'No'}",
            f"Attachments/JavaScript cleanup: {'Yes' if options.remove_attachments_js else 'No'}",
            f"Output size: {dst.stat().st_size / 1024:.1f} KB",
        ]
        return "\n".join(report)
    finally:
        doc.close()


def unlock_pdf(input_path: str, output_path: str, password: str) -> str:
    """Save an unencrypted copy without applying content-cleanup operations."""
    src = Path(input_path).expanduser().resolve()
    dst = Path(output_path).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Input PDF not found: {src}")
    if src == dst:
        raise ValueError("Output path must be different from the original PDF path.")
    if dst.suffix.lower() != ".pdf":
        raise ValueError("Output filename must end in .pdf.")
    dst.parent.mkdir(parents=True, exist_ok=True)

    probe = fitz.open(str(src))
    source_required_password = bool(probe.needs_pass)
    probe.close()
    doc = open_pdf(str(src), password)
    try:
        page_count = len(doc)
        if dst.exists():
            dst.unlink()
        doc.save(
            str(dst),
            garbage=3 if (page_count >= 100 or src.stat().st_size >= 30 * 1024 * 1024) else 4,
            deflate=True,
            encryption=fitz.PDF_ENCRYPT_NONE,
        )
    finally:
        doc.close()

    if not dst.is_file() or dst.stat().st_size == 0:
        raise RuntimeError("The unlocked PDF copy was not created correctly.")

    # Verify the result opens without any password.
    check = fitz.open(str(dst))
    try:
        if check.needs_pass:
            raise RuntimeError("The output still requires a password. Try another PDF viewer or method.")
        if len(check) != page_count:
            raise RuntimeError("The unlocked copy failed verification: its page count changed.")
    finally:
        check.close()

    return "\n".join([
        f"Unlocked copy saved: {dst}",
        f"Pages preserved: {page_count}",
        (
            "Password protection: Removed (output opens without a password)"
            if source_required_password
            else "Password protection: Source was not password-protected"
        ),
        f"Output size: {dst.stat().st_size / 1024:.1f} KB",
        "The original PDF was not changed.",
    ])



# ---------------------------------------------------------------------------
# Helpers added for the phone/tablet app (the functions above are the original
# desktop engine, unchanged).
# ---------------------------------------------------------------------------
import json


_PREVIEW = {"key": None, "doc": None}


def close_preview_cache() -> None:
    """Release the document kept open for fast page flipping."""
    doc = _PREVIEW.get("doc")
    if doc is not None:
        try:
            doc.close()
        except Exception:
            pass
    _PREVIEW["key"] = None
    _PREVIEW["doc"] = None


def preview_pdf(path: str, password: str = "", page_index: int = 0, zoom: float = 1.2) -> dict:
    """Render one page to JPEG bytes for the on-screen preview (key kept as "png")."""
    import os
    st = os.stat(path)
    key = (path, password, st.st_size, int(st.st_mtime))
    if _PREVIEW["key"] != key:
        close_preview_cache()
        _PREVIEW["doc"] = open_pdf(path, password)
        _PREVIEW["key"] = key
    doc = _PREVIEW["doc"]
    count = len(doc)
    page_index = max(0, min(int(page_index), count - 1))
    page = doc[page_index]
    w, h = page.rect.width, page.rect.height
    z = min(float(zoom), 2400.0 / max(w, h, 1.0))
    pix = page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
    return {"png": pix.tobytes("jpeg", jpg_quality=85), "pages": count, "page": page_index, "w": w, "h": h}


def is_protected(path: str) -> bool:
    doc = fitz.open(path)
    try:
        return bool(doc.needs_pass)
    finally:
        doc.close()


def _emit(message: str) -> None:
    """Forward progress text to the web UI (no-op outside the browser)."""
    try:
        import js
        from pyodide.ffi import to_js
        js.postMessage(to_js({"type": "status", "text": message}, dict_converter=js.Object.fromEntries))
    except Exception:
        pass


def run_job(job_json: str) -> str:
    """Entry point used by the web worker. Takes/returns JSON strings."""
    job = json.loads(job_json)
    kind = job["kind"]
    pw = job.get("password", "")
    if kind == "analyze":
        text = analyze_pdf(
            job["input"], parse_phrases(job.get("watermark", "")), pw,
            parse_phrases(job.get("header", "")), parse_phrases(job.get("footer", "")),
            status=_emit,
        )
        return json.dumps({"ok": True, "report": text})
    if kind == "unlock":
        return json.dumps({"ok": True, "report": unlock_pdf(job["input"], job["output"], pw)})
    if kind == "clean":
        o = job["options"]
        opts = CleanOptions(
            remove_metadata=bool(o["remove_metadata"]),
            top_percent=float(o["top"]),
            bottom_percent=float(o["bottom"]),
            watermark_phrases=parse_phrases(o.get("watermark", "")),
            header_phrases=parse_phrases(o.get("header", "")),
            footer_phrases=parse_phrases(o.get("footer", "")),
            custom_regions=parse_regions(o.get("regions", "")),
            remove_image_watermarks=bool(o["remove_image_watermarks"]),
            image_watermark_xrefs=parse_image_xrefs(o.get("xrefs", "")),
            remove_annotations=bool(o["remove_annotations"]),
            remove_links=bool(o["remove_links"]),
            remove_attachments_js=bool(o["remove_extras"]),
            remove_hidden_text=bool(o.get("remove_hidden_text", False)),
        )
        return json.dumps({"ok": True, "report": clean_pdf(job["input"], job["output"], opts, status=_emit, password=pw)})
    raise ValueError("Unknown job: " + kind)
