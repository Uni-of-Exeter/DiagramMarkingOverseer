"""app.py — Marking Overseer Flask application.

Run with: python app.py
Open:     http://127.0.0.1:5001
"""

from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock

from flask import Flask, Response, jsonify, render_template, request

import matrix as mat
import scanner
import store

app = Flask(__name__, template_folder="templates", static_folder="static")

# ── Config ────────────────────────────────────────────────────────────────────

_CONFIG_PATH = Path(__file__).parent / "config.json"

_DEFAULTS: dict = {
    "data_root": os.environ.get("OVERSEER_DATA_ROOT", ""),
    "aws_profile": "IncubatorDevOps",
    "aws_region": "eu-north-1",
    "anthropic_api_key": "",
    "extraction_provider": "bedrock",
    "extraction_model": "eu.anthropic.claude-opus-4-7",
    "marking_models": [
        {
            "provider": "bedrock",
            "model": "eu.anthropic.claude-opus-4-7",
            "label": "Bedrock Opus 4.7",
            "enabled": True,
        }
    ],
    "marking_approaches": ["oneshot"],
    "parallel_workers": 4,
    "render_dpi": 150,
    "skip_existing": True,
}


def load_config() -> dict:
    if _CONFIG_PATH.exists():
        try:
            saved = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            return {**_DEFAULTS, **saved}
        except Exception:
            pass
    return dict(_DEFAULTS)


def save_config(cfg: dict) -> None:
    _CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Job queue ─────────────────────────────────────────────────────────────────

_JOBS: dict[str, dict] = {}
_JOBS_LOCK = Lock()


def _new_job(name: str, total: int) -> str:
    jid = str(uuid.uuid4())[:8]
    with _JOBS_LOCK:
        _JOBS[jid] = {
            "id": jid, "name": name, "total": total,
            "done": 0, "errors": 0, "log": [], "running": True,
        }
    return jid


def _job_log(jid: str, msg: str) -> None:
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        if j:
            j["log"].append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            if len(j["log"]) > 300:
                j["log"] = j["log"][-300:]


def _job_tick(jid: str, error: bool = False) -> None:
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        if j:
            j["done"] += 1
            if error:
                j["errors"] += 1


def _job_finish(jid: str) -> None:
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        if j:
            j["running"] = False


def _job_snap(jid: str) -> dict | None:
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        return dict(j) if j else None


# ── AWS SSO ───────────────────────────────────────────────────────────────────

def check_aws(cfg: dict) -> tuple[bool, str]:
    profile = cfg.get("aws_profile")
    try:
        import boto3
        session = boto3.Session(profile_name=profile) if profile else boto3.Session()
        session.client("sts").get_caller_identity()
        return True, "AWS credentials valid."
    except Exception:
        if profile:
            try:
                r = subprocess.run(
                    ["aws", "sso", "login", "--profile", profile],
                    capture_output=True, text=True, timeout=120,
                )
                if r.returncode == 0:
                    return True, "SSO login successful."
                return False, f"SSO login failed: {r.stderr[:200]}"
            except Exception as e2:
                return False, f"Cannot run aws sso login: {e2}"
        return False, "No AWS profile configured."


# ── Routes: config ────────────────────────────────────────────────────────────

@app.route("/api/config", methods=["GET"])
def api_get_config():
    cfg = load_config()
    safe = dict(cfg)
    if safe.get("anthropic_api_key"):
        safe["anthropic_api_key"] = "***"
    return jsonify(safe)


@app.route("/api/config", methods=["POST"])
def api_save_config():
    data = request.json or {}
    cfg = load_config()
    if data.get("anthropic_api_key") == "***":
        data["anthropic_api_key"] = cfg.get("anthropic_api_key", "")
    cfg.update(data)
    save_config(cfg)
    return jsonify({"status": "ok"})


@app.route("/api/config/aws_check", methods=["POST"])
def api_aws_check():
    ok, msg = check_aws(load_config())
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/config/questions")
def api_questions():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    return jsonify(store.list_questions(dr) if dr else [])


# ── Routes: students ──────────────────────────────────────────────────────────

@app.route("/api/students")
def api_students():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"students": [], "count": 0})
    students = store.read_students(dr)
    return jsonify({"students": students, "count": len(students)})


@app.route("/api/students/import", methods=["POST"])
def api_import_students():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    entries: list[dict] = []
    if request.content_type and "multipart" in request.content_type:
        f = request.files.get("file")
        if not f:
            return jsonify({"error": "no file"}), 400
        raw = f.read().decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(raw))
        for row in reader:
            entry: dict = {}
            for k, v in row.items():
                k2 = k.strip().lower().replace(" ", "_").replace("-", "_")
                v2 = (v or "").strip()
                if not v2:
                    continue
                if k2 in ("studentid", "student_id"):
                    entry["StudentID"] = v2
                elif k2 in ("candidatenumber", "candidate_number"):
                    entry["CandidateNumber"] = v2
                elif k2 == "name":
                    entry["Name"] = v2
                elif k2 == "email":
                    entry["Email"] = v2
            if entry:
                entries.append(entry)
    else:
        entries = request.json or []

    existing = store.read_students(dr)
    merged: dict = {s.get("StudentID") or s.get("CandidateNumber") or s.get("Name", ""): s
                    for s in existing}
    for e in entries:
        key = e.get("StudentID") or e.get("CandidateNumber") or e.get("Name", "")
        merged[key] = e
    store.write_students(dr, list(merged.values()))
    return jsonify({"status": "ok", "imported": len(entries), "total": len(merged)})


# ── Routes: matrix ────────────────────────────────────────────────────────────

@app.route("/api/matrix")
def api_matrix():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"students": [], "questions": [], "error": "data_root not set"})
    questions = store.list_questions(dr)
    records = store.get_all_records(dr)
    attempts = store.read_attempts(dr)
    overrides = store.read_overrides(dr)
    students = store.read_students(dr)
    rows = mat.build_matrix(records, attempts, overrides, students, questions)
    return jsonify({"students": rows, "questions": questions})


@app.route("/api/export/csv")
def api_export_csv():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return "data_root not set", 400
    questions = store.list_questions(dr)
    records = store.get_all_records(dr)
    attempts = store.read_attempts(dr)
    overrides = store.read_overrides(dr)
    students = store.read_students(dr)
    rows = mat.build_matrix(records, attempts, overrides, students, questions)
    csv_str = mat.export_csv(rows, questions)
    return Response(
        csv_str, mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=marking_results.csv"},
    )


# ── Routes: review ────────────────────────────────────────────────────────────

@app.route("/api/review/<student_key>/<question>")
def api_review(student_key, question):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    records = store.get_all_records(dr)
    attempts_all = store.read_attempts(dr)
    overrides = store.read_overrides(dr)

    file_records = [
        r for r in records.values()
        if mat.student_key(r) == student_key and r.get("question") == question
    ]

    attempts_by_fid: dict[str, list] = {}
    for a in attempts_all:
        attempts_by_fid.setdefault(a["file_id"], []).append(a)

    q_override = overrides.get(student_key, {}).get(question)
    detail = []
    for r in file_records:
        fid = r["file_id"]
        fid_attempts = attempts_by_fid.get(fid, [])
        detail.append({
            "file_id": fid,
            "question_id": r.get("QuestionID"),
            "human_mark_body": r.get("human_mark_body"),
            "human_mark_header": r.get("human_mark_header"),
            "human_mark_conflict": bool(
                r.get("human_mark_body") and r.get("human_mark_header")
                and r["human_mark_body"] != r["human_mark_header"]
            ),
            "attempts": fid_attempts,
            "resolved": mat.resolve_mark(fid_attempts, q_override),
            "body_image_url": f"/pdf/body/{question}/{fid}/image",
            "answer_image_url": (
                f"/pdf/answer/{question}/{r['QuestionID']}/image"
                if r.get("QuestionID") else None
            ),
        })

    return jsonify({
        "student_key": student_key,
        "question": question,
        "override": q_override,
        "file_records": detail,
    })


@app.route("/api/review/<student_key>/<question>/override", methods=["POST"])
def api_set_override(student_key, question):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    data = request.json or {}
    value = data.get("value")  # "pass" | "fail" | "pending" | None (clear)
    store.write_override(dr, student_key, question, value)
    return jsonify({"status": "ok"})


@app.route("/api/attempt/<attempt_id>/reject", methods=["POST"])
def api_reject_attempt(attempt_id):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    data = request.json or {}
    store.update_attempt(dr, attempt_id, {"rejected": data.get("rejected", True)})
    return jsonify({"status": "ok"})


# ── Routes: PDF serving ───────────────────────────────────────────────────────

def _serve_png(pdf_path: Path | None, page: int, dpi: int) -> Response:
    if not pdf_path:
        return Response("Not found", status=404)
    try:
        png = scanner.render_pdf_page(pdf_path.read_bytes(), page, dpi)
        return Response(png, mimetype="image/png")
    except Exception as e:
        return Response(str(e), status=500)


@app.route("/pdf/body/<question>/<file_id>/image")
def serve_body_image(question, file_id):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    page = int(request.args.get("page", 0))
    dpi = int(request.args.get("dpi", cfg.get("render_dpi", 150)))
    return _serve_png(store.get_body_pdf(dr, question, file_id), page, dpi)


@app.route("/pdf/header/<question>/<file_id>/image")
def serve_header_image(question, file_id):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    dpi = int(request.args.get("dpi", cfg.get("render_dpi", 150)))
    return _serve_png(store.get_header_pdf(dr, question, file_id), 0, dpi)


@app.route("/pdf/answer/<question>/<qid>/image")
def serve_answer_image(question, qid):
    cfg = load_config()
    dr = cfg.get("data_root", "")
    dpi = int(request.args.get("dpi", cfg.get("render_dpi", 150)))
    return _serve_png(store.get_answer_pdf(dr, question, qid), 0, dpi)


# ── Routes: jobs ──────────────────────────────────────────────────────────────

@app.route("/api/jobs/<jid>/status")
def api_job_status(jid):
    snap = _job_snap(jid)
    return jsonify(snap) if snap else (jsonify({"error": "not found"}), 404)


@app.route("/api/jobs/recent")
def api_jobs_recent():
    with _JOBS_LOCK:
        jobs = list(_JOBS.values())
    return jsonify(jobs[-30:])


def _run_parallel(jid: str, items: list, worker_fn, workers: int) -> None:
    """Generic parallel runner that feeds items to worker_fn and handles errors."""
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futs = {ex.submit(worker_fn, item): item for item in items}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                _job_log(jid, f"  CRASH: {e}")
    _job_log(jid, "Done.")
    _job_finish(jid)


@app.route("/api/jobs/extract_headers", methods=["POST"])
def api_extract_headers():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    data = request.json or {}
    questions = data.get("questions") or store.list_questions(dr)
    all_pdfs = [
        (q, p)
        for q in questions
        for p in sorted((Path(dr) / "header" / q).glob("header_scan_*.pdf"))
    ]
    if cfg.get("skip_existing", True):
        all_pdfs = [
            (q, p) for q, p in all_pdfs
            if not any(
                store.read_scans(dr, "header", q).get(p.stem[len("header_scan_"):], {}).get(k)
                for k in ("StudentID", "CandidateNumber", "Name")
            )
        ]

    jid = _new_job("extract_headers", len(all_pdfs))
    _job_log(jid, f"Extracting student IDs from {len(all_pdfs)} header PDFs")

    def worker(item):
        q, pdf_path = item
        fid = pdf_path.stem[len("header_scan_"):]
        try:
            result = scanner.extract_student_identifier(
                pdf_path.read_bytes(),
                provider=cfg["extraction_provider"],
                model=cfg["extraction_model"],
                aws_profile=cfg.get("aws_profile"),
                aws_region=cfg.get("aws_region", "eu-north-1"),
                anthropic_api_key=cfg.get("anthropic_api_key"),
                dpi=cfg.get("render_dpi", 150),
            )
            store.upsert_scan_field(dr, "header", q, fid, {
                "StudentID": result.get("StudentID"),
                "CandidateNumber": result.get("CandidateNumber"),
                "Name": result.get("Name"),
            })
            _job_log(jid, f"  {pdf_path.name}: {result['raw']!r}")
            _job_tick(jid)
        except Exception as e:
            _job_log(jid, f"  ERROR {pdf_path.name}: {e}")
            _job_tick(jid, error=True)

    threading.Thread(
        target=_run_parallel,
        args=(jid, all_pdfs, worker, cfg.get("parallel_workers", 4)),
        daemon=True,
    ).start()
    return jsonify({"job_id": jid})


@app.route("/api/jobs/extract_bodies", methods=["POST"])
def api_extract_bodies():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    data = request.json or {}
    questions = data.get("questions") or store.list_questions(dr)
    all_pdfs = [
        (q, p)
        for q in questions
        for p in sorted((Path(dr) / "body" / q).glob("body_scan_*.pdf"))
    ]
    if cfg.get("skip_existing", True):
        all_pdfs = [
            (q, p) for q, p in all_pdfs
            if not store.read_scans(dr, "body", q).get(
                p.stem[len("body_scan_"):], {}
            ).get("QuestionID")
        ]

    jid = _new_job("extract_bodies", len(all_pdfs))
    _job_log(jid, f"Extracting QIDs from {len(all_pdfs)} body PDFs")

    def worker(item):
        q, pdf_path = item
        fid = pdf_path.stem[len("body_scan_"):]
        try:
            result = scanner.extract_question_id(
                pdf_path.read_bytes(),
                provider=cfg["extraction_provider"],
                model=cfg["extraction_model"],
                aws_profile=cfg.get("aws_profile"),
                aws_region=cfg.get("aws_region", "eu-north-1"),
                anthropic_api_key=cfg.get("anthropic_api_key"),
                dpi=cfg.get("render_dpi", 150),
            )
            if result["question_id"]:
                store.upsert_scan_field(dr, "body", q, fid, {"QuestionID": result["question_id"]})
            _job_log(jid, f"  {pdf_path.name}: {result['question_id']!r}")
            _job_tick(jid)
        except Exception as e:
            _job_log(jid, f"  ERROR {pdf_path.name}: {e}")
            _job_tick(jid, error=True)

    threading.Thread(
        target=_run_parallel,
        args=(jid, all_pdfs, worker, cfg.get("parallel_workers", 4)),
        daemon=True,
    ).start()
    return jsonify({"job_id": jid})


@app.route("/api/jobs/extract_human_marks", methods=["POST"])
def api_extract_human_marks():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    data = request.json or {}
    questions = data.get("questions") or store.list_questions(dr)
    all_items = []
    for q in questions:
        for pdf in sorted((Path(dr) / "body" / q).glob("body_scan_*.pdf")):
            all_items.append(("body", q, pdf))
        for pdf in sorted((Path(dr) / "header" / q).glob("header_scan_*.pdf")):
            all_items.append(("header", q, pdf))

    jid = _new_job("extract_human_marks", len(all_items))
    _job_log(jid, f"Extracting TA marks from {len(all_items)} PDFs")

    def worker(item):
        side, q, pdf_path = item
        prefix = f"{side}_scan_"
        fid = pdf_path.stem[len(prefix):]
        try:
            if side == "body":
                result = scanner.extract_human_mark_body(
                    pdf_path.read_bytes(),
                    provider=cfg["extraction_provider"], model=cfg["extraction_model"],
                    aws_profile=cfg.get("aws_profile"), aws_region=cfg.get("aws_region", "eu-north-1"),
                    anthropic_api_key=cfg.get("anthropic_api_key"), dpi=cfg.get("render_dpi", 150),
                )
                store.upsert_scan_field(dr, "body", q, fid, {"human_mark_body": result["mark"]})
            else:
                result = scanner.extract_human_mark_header(
                    pdf_path.read_bytes(),
                    provider=cfg["extraction_provider"], model=cfg["extraction_model"],
                    aws_profile=cfg.get("aws_profile"), aws_region=cfg.get("aws_region", "eu-north-1"),
                    anthropic_api_key=cfg.get("anthropic_api_key"), dpi=cfg.get("render_dpi", 150),
                )
                store.upsert_scan_field(dr, "header", q, fid, {"human_mark_header": result["mark"]})
            _job_log(jid, f"  {side}/{pdf_path.name}: {result['mark']!r}")
            _job_tick(jid)
        except Exception as e:
            _job_log(jid, f"  ERROR {side}/{pdf_path.name}: {e}")
            _job_tick(jid, error=True)

    threading.Thread(
        target=_run_parallel,
        args=(jid, all_items, worker, cfg.get("parallel_workers", 4)),
        daemon=True,
    ).start()
    return jsonify({"job_id": jid})


@app.route("/api/jobs/ai_mark", methods=["POST"])
def api_ai_mark():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify({"error": "data_root not set"}), 400

    data = request.json or {}
    questions = data.get("questions") or store.list_questions(dr)
    approaches = data.get("approaches", cfg.get("marking_approaches", ["oneshot"]))
    model_cfgs = [m for m in cfg.get("marking_models", []) if m.get("enabled", True)]
    skip = data.get("skip_existing", cfg.get("skip_existing", True))

    if not model_cfgs:
        return jsonify({"error": "No models enabled in config"}), 400

    records = store.get_all_records(dr)
    existing = store.read_attempts(dr)
    done_keys: set = set()
    if skip:
        for a in existing:
            if a.get("result") in ("pass", "fail"):
                done_keys.add((a["file_id"], a.get("ai_approach"), a.get("model")))

    work: list = []
    for fid, rec in records.items():
        if rec.get("question") not in questions:
            continue
        if not rec.get("QuestionID"):
            continue
        for approach in approaches:
            for mc in model_cfgs:
                if skip and (fid, approach, mc["model"]) in done_keys:
                    continue
                work.append((rec, approach, mc))

    jid = _new_job("ai_marking", len(work))
    _job_log(jid, f"AI marking: {len(work)} items ({len(approaches)} approaches × {len(model_cfgs)} models)")

    def worker(item):
        rec, approach, mc = item
        fid = rec["file_id"]
        question = rec["question"]
        qid = rec["QuestionID"]
        attempt: dict = {
            "attempt_id": str(uuid.uuid4()),
            "file_id": fid,          # PRIVACY: no student identity here
            "question": question,
            "question_id": qid,
            "ai_approach": approach,
            "provider": mc["provider"],
            "model": mc["model"],
            "model_label": mc.get("label", mc["model"]),
            "result": None, "reasoning": None, "step1_result": None,
            "raw_response": None, "input_tokens": 0, "output_tokens": 0,
            "latency_ms": 0, "cost_usd": 0.0,
            "timestamp": datetime.now().isoformat(),
            "rejected": False, "error": None,
        }
        try:
            body_path = store.get_body_pdf(dr, question, fid)
            if not body_path:
                raise FileNotFoundError(f"No body PDF for {fid}")
            body_bytes = body_path.read_bytes()

            answer_path = store.get_answer_pdf(dr, question, qid)
            answer_bytes = answer_path.read_bytes() if answer_path else None

            kwargs = dict(
                provider=mc["provider"], model=mc["model"],
                aws_profile=cfg.get("aws_profile"),
                aws_region=cfg.get("aws_region", "eu-north-1"),
                anthropic_api_key=cfg.get("anthropic_api_key"),
                dpi=cfg.get("render_dpi", 150),
            )

            if approach == "oneshot":
                if not answer_bytes:
                    raise FileNotFoundError(f"No answer PDF for QID {qid}")
                result = scanner.ai_mark_oneshot(answer_bytes, body_bytes, **kwargs)
            elif approach == "twostep":
                if not answer_bytes:
                    raise FileNotFoundError(f"No answer PDF for QID {qid}")
                result = scanner.ai_mark_twostep(answer_bytes, body_bytes, **kwargs)
            elif approach == "answer_sheet":
                if not answer_bytes:
                    raise FileNotFoundError(f"No answer PDF for QID {qid}")
                result = scanner.ai_mark_answer_sheet(answer_bytes, body_bytes, **kwargs)
            else:
                raise ValueError(f"Unknown approach: {approach!r}")

            attempt.update({
                "result": result["result"],
                "reasoning": result["reasoning"],
                "step1_result": result.get("step1_result"),
                "raw_response": result.get("raw_response"),
                "input_tokens": result["input_tokens"],
                "output_tokens": result["output_tokens"],
                "latency_ms": result["latency_ms"],
                "cost_usd": mat.cost_estimate(mc["model"], result["input_tokens"], result["output_tokens"]),
            })
            _job_log(jid, f"  {fid} [{approach}/{mc.get('label', mc['model'])}]: {result['result']}")
            _job_tick(jid)
        except Exception as e:
            attempt["error"] = str(e)
            _job_log(jid, f"  ERROR {fid} [{approach}]: {e}")
            _job_tick(jid, error=True)

        store.append_attempt(dr, attempt)

    threading.Thread(
        target=_run_parallel,
        args=(jid, work, worker, cfg.get("parallel_workers", 4)),
        daemon=True,
    ).start()
    return jsonify({"job_id": jid})


# ── Routes: stats ─────────────────────────────────────────────────────────────

@app.route("/api/stats/attempts")
def api_attempt_stats():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify([])
    return jsonify(mat.attempt_stats(store.read_attempts(dr)))


@app.route("/api/stats/attempts/detail")
def api_attempts_detail():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    if not dr:
        return jsonify([])
    attempts = store.read_attempts(dr)
    for f in ("question", "ai_approach", "model"):
        v = request.args.get(f)
        if v:
            attempts = [a for a in attempts if a.get(f) == v]
    return jsonify(attempts[-500:])


# ── Main page ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    cfg = load_config()
    dr = cfg.get("data_root", "")
    questions = store.list_questions(dr) if dr else []
    return render_template("index.html", questions=questions, data_root=dr)


if __name__ == "__main__":
    print("Marking Overseer")
    print(f"Config:    {_CONFIG_PATH}")
    dr = load_config().get("data_root") or "(not set — configure in UI)"
    print(f"Data root: {dr}")
    print("Open:      http://127.0.0.1:5001")
    app.run(debug=True, port=5001, threaded=True)
