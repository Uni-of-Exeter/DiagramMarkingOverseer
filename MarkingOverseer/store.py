"""store.py — All disk I/O for Marking Overseer.

Every read/write of Scans.json, attempts.json, overrides.json, and students.json
goes through this module. Nothing else reads or writes these files.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from threading import Lock

# Per-path locks so concurrent workers on different questions don't serialise each other.
_path_locks: dict[str, Lock] = {}
_path_locks_mutex = threading.Lock()


def _path_lock(path: Path) -> Lock:
    key = str(path)
    with _path_locks_mutex:
        if key not in _path_locks:
            _path_locks[key] = Lock()
        return _path_locks[key]


def _atomic_write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


# ── Scans.json ────────────────────────────────────────────────────────────────

def _scans_path(data_root: str, scan_type: str, question: str) -> Path:
    return Path(data_root) / scan_type / question / "Scans.json"


def read_scans(data_root: str, scan_type: str, question: str) -> dict:
    return _read_json(_scans_path(data_root, scan_type, question), {})


def write_scans(data_root: str, scan_type: str, question: str, data: dict) -> None:
    _atomic_write(_scans_path(data_root, scan_type, question), data)


def upsert_scan_field(
    data_root: str, scan_type: str, question: str, file_id: str, fields: dict
) -> None:
    """Thread-safe update of a single file_id's fields in Scans.json."""
    path = _scans_path(data_root, scan_type, question)
    with _path_lock(path):
        data = read_scans(data_root, scan_type, question)
        if file_id not in data:
            data[file_id] = {}
        data[file_id].update(fields)
        write_scans(data_root, scan_type, question, data)


# ── Merged records ────────────────────────────────────────────────────────────

def get_merged_records(data_root: str, question: str) -> dict[str, dict]:
    """
    Merge header and body Scans.json for one question, keyed by file_id.
    Identity fields (StudentID, CandidateNumber, Name) come from header only.
    Work fields (QuestionID, human_mark_body) come from body only.
    """
    header = read_scans(data_root, "header", question)
    body = read_scans(data_root, "body", question)
    merged = {}
    for fid in set(header) | set(body):
        h = header.get(fid, {})
        b = body.get(fid, {})
        merged[fid] = {
            "file_id": fid,
            "question": question,
            "StudentID": h.get("StudentID"),
            "CandidateNumber": h.get("CandidateNumber"),
            "Name": h.get("Name"),
            "QuestionID": b.get("QuestionID"),
            "human_mark_body": b.get("human_mark_body"),
            "human_mark_header": h.get("human_mark_header"),
        }
    return merged


def get_all_records(data_root: str) -> dict[str, dict]:
    records: dict[str, dict] = {}
    for q in list_questions(data_root):
        records.update(get_merged_records(data_root, q))
    return records


# ── File paths ────────────────────────────────────────────────────────────────

def get_body_pdf(data_root: str, question: str, file_id: str) -> Path | None:
    p = Path(data_root) / "body" / question / f"body_scan_{file_id}.pdf"
    return p if p.exists() else None


def get_header_pdf(data_root: str, question: str, file_id: str) -> Path | None:
    p = Path(data_root) / "header" / question / f"header_scan_{file_id}.pdf"
    return p if p.exists() else None


def get_answer_pdf(data_root: str, question: str, qid: str, answer_sheets_root: str = "") -> Path | None:
    """Find answer PDF for a question_id.

    Searches answer_sheets_root/{question}/ first (if configured), then falls
    back to body/{question}/ (excluding body_scan_* files).
    """
    qid_lower = qid.lower()
    if answer_sheets_root:
        for search_dir in (
            Path(answer_sheets_root) / question,  # per-question subfolder
            Path(answer_sheets_root),              # flat root
        ):
            if search_dir.exists():
                for pdf in search_dir.glob("*.pdf"):
                    if qid_lower in pdf.stem.lower():
                        return pdf
    body_dir = Path(data_root) / "body" / question
    if not body_dir.exists():
        return None
    for pdf in body_dir.glob("*.pdf"):
        if pdf.stem.startswith("body_scan_"):
            continue
        if qid_lower in pdf.stem.lower():
            return pdf
    return None


def list_file_ids(data_root: str, scan_type: str, question: str) -> list[str]:
    d = Path(data_root) / scan_type / question
    if not d.exists():
        return []
    prefix = f"{scan_type}_scan_"
    return [p.stem[len(prefix):] for p in sorted(d.glob(f"{prefix}*.pdf"))]


def list_questions(data_root: str) -> list[str]:
    body_dir = Path(data_root) / "body"
    if not body_dir.exists():
        return []
    return sorted(
        d.name for d in body_dir.iterdir()
        if d.is_dir() and re.match(r"Question\d+$", d.name)
    )


# ── Configurable overseer root ────────────────────────────────────────────────
# Attempts, overrides, and student data live under _overseer_base(data_root).
# Call configure_overseer_root() once at startup to redirect them.

_overseer_root_override: str = ""


def configure_overseer_root(path: str) -> None:
    global _overseer_root_override
    _overseer_root_override = path


def _overseer_base(data_root: str) -> Path:
    if _overseer_root_override:
        return Path(_overseer_root_override)
    return Path(data_root) / "MarkingOverseer"


# ── Attempts ──────────────────────────────────────────────────────────────────

def _attempts_path(data_root: str) -> Path:
    return _overseer_base(data_root) / "attempts.json"


def read_attempts(data_root: str) -> list[dict]:
    return _read_json(_attempts_path(data_root), [])


def append_attempt(data_root: str, attempt: dict) -> None:
    path = _attempts_path(data_root)
    with _path_lock(path):
        attempts = read_attempts(data_root)
        attempts.append(attempt)
        _atomic_write(path, attempts)


def update_attempt(data_root: str, attempt_id: str, fields: dict) -> bool:
    path = _attempts_path(data_root)
    with _path_lock(path):
        attempts = read_attempts(data_root)
        for a in attempts:
            if a.get("attempt_id") == attempt_id:
                a.update(fields)
                _atomic_write(path, attempts)
                return True
        return False


# ── Overrides ─────────────────────────────────────────────────────────────────

def _overrides_path(data_root: str) -> Path:
    return _overseer_base(data_root) / "overrides.json"


def read_overrides(data_root: str) -> dict:
    return _read_json(_overrides_path(data_root), {})


def write_override(data_root: str, student_key: str, question: str, value: str | None) -> None:
    """Set or clear a mark override. value=None clears."""
    path = _overrides_path(data_root)
    with _path_lock(path):
        overrides = read_overrides(data_root)
        if student_key not in overrides:
            overrides[student_key] = {}
        if value is None:
            overrides[student_key].pop(question, None)
        else:
            overrides[student_key][question] = value
        _atomic_write(path, overrides)


# ── Students ──────────────────────────────────────────────────────────────────

def _students_path(data_root: str) -> Path:
    return _overseer_base(data_root) / "students.json"


def read_students(data_root: str) -> list[dict]:
    return _read_json(_students_path(data_root), [])


def write_students(data_root: str, students: list[dict]) -> None:
    _atomic_write(_students_path(data_root), students)
