"""matrix.py — Pure computation: mark resolution, dashboard matrix, CSV export.

No disk I/O. No AI calls. All functions are deterministic given their inputs.
"""

from __future__ import annotations

import csv
import io


# ── Student matching ──────────────────────────────────────────────────────────

def match_student(identifier: dict, student_list: list[dict]) -> dict | None:
    """Match record identity fields against the imported student list.

    Priority: StudentID > CandidateNumber > Name (exact then case-insensitive).
    """
    sid = str(identifier.get("StudentID") or "").strip()
    cnum = str(identifier.get("CandidateNumber") or "").strip()
    name_lower = (identifier.get("Name") or "").strip().lower()

    for s in student_list:
        if sid and str(s.get("StudentID") or "") == sid:
            return s
        if cnum and str(s.get("CandidateNumber") or "") == cnum:
            return s

    if name_lower:
        for s in student_list:
            if (s.get("Name") or "").strip().lower() == name_lower:
                return s
    return None


def student_key(record: dict) -> str:
    """Stable, human-readable key for a student derived from whatever identifier is available."""
    if record.get("StudentID"):
        return f"sid_{record['StudentID']}"
    if record.get("CandidateNumber"):
        return f"cnum_{record['CandidateNumber']}"
    if record.get("Name"):
        return f"name_{record['Name'].strip().lower()}"
    return f"unknown_{record.get('file_id', 'x')[:8]}"


def display_name(record: dict, student_info: dict | None) -> str:
    if student_info and student_info.get("Name"):
        return student_info["Name"]
    if record.get("Name"):
        return record["Name"]
    if record.get("StudentID"):
        return f"Student {record['StudentID']}"
    if record.get("CandidateNumber"):
        return f"Candidate {record['CandidateNumber']}"
    return f"Unknown ({record.get('file_id', '')[:8]})"


# ── Mark resolution ───────────────────────────────────────────────────────────

def resolve_mark(attempts: list[dict], override: str | None) -> str:
    """Resolve a single student+question mark.

    Returns: "pass" | "fail" | "pending" | "not_attempted"
    Override wins if set. A student passes if any non-rejected attempt is "pass".
    """
    if override == "pending":
        return "pending"
    if override in ("pass", "fail"):
        return override

    active = [a for a in attempts if not a.get("rejected") and a.get("result") in ("pass", "fail")]
    if not active and not attempts:
        return "not_attempted"
    if not active:
        return "pending"
    if any(a["result"] == "pass" for a in active):
        return "pass"
    return "fail"


# ── Matrix builder ────────────────────────────────────────────────────────────

def build_matrix(
    records: dict[str, dict],
    attempts: list[dict],
    overrides: dict,
    students: list[dict],
    questions: list[str],
) -> list[dict]:
    """Build the student × question dashboard matrix.

    Returns a sorted list of student rows. Student identity is merged with
    marking data here (display layer only — AI calls never receive this combined data).
    """
    attempts_by_fid: dict[str, list] = {}
    for a in attempts:
        attempts_by_fid.setdefault(a["file_id"], []).append(a)

    rows: dict[str, dict] = {}

    for fid, record in records.items():
        skey = student_key(record)
        student_info = match_student(record, students)

        if skey not in rows:
            rows[skey] = {
                "student_key": skey,
                "display_name": display_name(record, student_info),
                "StudentID": record.get("StudentID"),
                "CandidateNumber": record.get("CandidateNumber"),
                "Name": record.get("Name"),
                "Email": student_info.get("Email") if student_info else None,
                "questions": {q: [] for q in questions},
            }

        q = record["question"]
        if q not in rows[skey]["questions"]:
            rows[skey]["questions"][q] = []

        q_override = overrides.get(skey, {}).get(q)
        file_attempts = attempts_by_fid.get(fid, [])

        rows[skey]["questions"][q].append({
            "file_id": fid,
            "question_id": record.get("QuestionID"),
            "human_mark_body": record.get("human_mark_body"),
            "human_mark_header": record.get("human_mark_header"),
            "human_mark_conflict": bool(
                record.get("human_mark_body")
                and record.get("human_mark_header")
                and record["human_mark_body"] != record["human_mark_header"]
            ),
            "attempts": file_attempts,
            "resolved": resolve_mark(file_attempts, q_override),
        })

    result = []
    for skey, sdata in sorted(rows.items(), key=lambda x: x[1]["display_name"].lower()):
        q_override_map = overrides.get(skey, {})
        q_status: dict[str, str] = {}

        for q in questions:
            file_list = sdata["questions"].get(q, [])
            q_ov = q_override_map.get(q)

            if q_ov in ("pass", "fail", "pending"):
                q_status[q] = q_ov
            elif not file_list:
                q_status[q] = "not_attempted"
            elif any(f["resolved"] == "pass" for f in file_list):
                q_status[q] = "pass"
            elif any(f["resolved"] == "fail" for f in file_list):
                q_status[q] = "fail"
            elif any(f["attempts"] for f in file_list):
                q_status[q] = "pending"
            else:
                q_status[q] = "not_marked"

        row = {k: v for k, v in sdata.items() if k != "questions"}
        row["question_files"] = sdata["questions"]
        row["question_status"] = q_status
        row["total_passed"] = sum(1 for v in q_status.values() if v == "pass")
        row["all_passed"] = row["total_passed"] == len(questions) and len(questions) > 0
        result.append(row)

    return result


# ── Stats ─────────────────────────────────────────────────────────────────────

def attempt_stats(attempts: list[dict], records: dict | None = None) -> list[dict]:
    """Aggregate attempt counts/rates/cost by model × approach × prompt_hash."""
    groups: dict[str, dict] = {}
    for a in attempts:
        if not a.get("result"):
            continue
        model_label = a.get("model_label", a.get("model", "?"))
        approach = a.get("ai_approach", "?")
        ph = a.get("prompt_hash") or ""
        key = f"{model_label}|{approach}|{ph}"
        label = f"{model_label} / {approach}"
        if ph:
            label += f" [{ph[:6]}]"
        if key not in groups:
            groups[key] = {
                "label": label,
                "model": a.get("model"),
                "model_label": model_label,
                "approach": approach,
                "prompt_hash": ph or None,
                "count": 0, "pass": 0, "fail": 0, "error": 0,
                "total_input_tokens": 0, "total_output_tokens": 0,
                "total_cost_usd": 0.0, "total_latency_ms": 0,
                "ta_agree": 0, "ta_total": 0,
            }
        g = groups[key]
        g["count"] += 1
        g[a.get("result", "error")] = g.get(a.get("result", "error"), 0) + 1
        g["total_input_tokens"] += a.get("input_tokens", 0)
        g["total_output_tokens"] += a.get("output_tokens", 0)
        g["total_cost_usd"] += a.get("cost_usd", 0.0)
        g["total_latency_ms"] += a.get("latency_ms", 0)
        if records is not None:
            human = records.get(a["file_id"], {}).get("human_mark_header")
            if human in ("pass", "fail"):
                g["ta_total"] += 1
                if human == a.get("result"):
                    g["ta_agree"] += 1

    for g in groups.values():
        n = g["count"]
        g["avg_latency_ms"] = g["total_latency_ms"] // n if n else 0
        g["avg_cost_usd"] = g["total_cost_usd"] / n if n else 0.0
        g["pass_rate"] = g.get("pass", 0) / n if n else 0.0
        ta_total = g["ta_total"]
        g["ta_correlation"] = g["ta_agree"] / ta_total if ta_total else None

    return sorted(groups.values(), key=lambda x: x["label"])


def ta_stats(records: dict) -> list[dict]:
    pass_ = 0
    fail_ = 0
    for r in records.values():
        h = r.get("human_mark_header")
        if h == "pass":
            pass_ += 1
        elif h == "fail":
            fail_ += 1
    count = pass_ + fail_
    if not count:
        return []
    return [{
        "label": "TA / human",
        "model": None,
        "model_label": "TA",
        "approach": "human",
        "prompt_hash": None,
        "count": count,
        "pass": pass_,
        "fail": fail_,
        "error": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cost_usd": 0.0,
        "total_latency_ms": 0,
        "avg_latency_ms": 0,
        "avg_cost_usd": 0.0,
        "pass_rate": pass_ / count,
        "ta_agree": count,
        "ta_total": count,
        "ta_correlation": 1.0,
    }]


def cost_estimate(model_id: str, input_tokens: int, output_tokens: int) -> float:
    RATES = {
        # Anthropic Claude (per million tokens: input, output)
        "claude-opus-4-7": (15.0, 75.0),
        "claude-opus-4-5": (15.0, 75.0),
        "claude-sonnet-4-6": (3.0, 15.0),
        "claude-sonnet-4-5": (3.0, 15.0),
        "claude-haiku-4-5": (0.8, 4.0),
        # Amazon Nova (base rates; eu. cross-region ~10% premium not reflected)
        "nova-pro": (0.8, 3.2),
        "nova-2-lite": (0.06, 0.24),
        "nova-lite": (0.06, 0.24),
        "nova-2-micro": (0.035, 0.14),
        "nova-micro": (0.035, 0.14),
    }
    for key, (in_r, out_r) in RATES.items():
        if key in model_id:
            return (input_tokens * in_r + output_tokens * out_r) / 1_000_000
    return 0.0


# ── CSV export ────────────────────────────────────────────────────────────────

def export_csv(matrix_rows: list[dict], questions: list[str]) -> str:
    out = io.StringIO()
    fields = ["display_name", "StudentID", "CandidateNumber", "Email", "total_passed", "all_passed"] + questions
    writer = csv.DictWriter(out, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for row in matrix_rows:
        writer.writerow({
            "display_name": row.get("display_name", ""),
            "StudentID": row.get("StudentID", ""),
            "CandidateNumber": row.get("CandidateNumber", ""),
            "Email": row.get("Email", ""),
            "total_passed": row.get("total_passed", 0),
            "all_passed": row.get("all_passed", False),
            **{q: row["question_status"].get(q, "not_attempted") for q in questions},
        })
    return out.getvalue()
