"""scanner.py — AI extraction and marking.

PRIVACY CONTRACT
================
IDENTITY ZONE  — functions that receive header PDF bytes only.
  extract_student_identifier()
  extract_human_mark_header()

  These may see student identifiers. They never receive student work.

WORK ZONE      — functions that receive body/answer PDF bytes only.
  extract_question_id()
  extract_human_mark_body()
  ai_mark_oneshot()
  ai_mark_twostep()
  ai_mark_answer_sheet()

  These may analyse student maths work. They never receive student identifiers.

No function anywhere accepts both header bytes and body bytes.
The caller (app.py) is responsible for never combining them in a single AI call.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time

import fitz  # PyMuPDF


# ── PDF utilities ─────────────────────────────────────────────────────────────

# Fixed step-down points; render_pdf_page inserts the caller's max at the front.
_DPI_STEPS = [300, 250, 200, 150, 120, 100, 80, 72]
_PNG_RAW_LIMIT = (5 * 1024 * 1024 * 3) // 4  # so base64-encoded < 5 MB


def render_pdf_page(pdf_bytes: bytes, page_num: int = 0, dpi: int = 150) -> bytes:
    """Render one page to PNG.

    `dpi` is the maximum resolution. If the PNG exceeds the API size limit,
    the function steps down through lower DPI values automatically until it fits.
    """
    # Build deduplicated descending ladder starting at the requested max.
    seen: set[int] = set()
    ladder: list[int] = []
    for d in [dpi] + [s for s in _DPI_STEPS if s < dpi]:
        if d not in seen:
            seen.add(d)
            ladder.append(d)

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        idx = min(page_num, len(doc) - 1)
        page = doc[idx]
        png = b""
        for try_dpi in ladder:
            zoom = try_dpi / 72
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            png = pix.tobytes("png")
            if len(png) <= _PNG_RAW_LIMIT:
                return png
        return png  # last resort: smallest result even if over limit
    finally:
        doc.close()


# ── Thread-local AI client cache ──────────────────────────────────────────────
# Each worker thread keeps its own boto3/anthropic client so they never share
# mutable session state, which removes per-call session-creation overhead.

_tls = threading.local()


def _bedrock_client(profile: str | None, region: str):
    key = f"bedrock|{profile}|{region}"
    cache = _tls.__dict__.setdefault("clients", {})
    if key not in cache:
        import boto3
        session = boto3.Session(profile_name=profile) if profile else boto3.Session()
        cache[key] = session.client("bedrock-runtime", region_name=region)
    return cache[key]


def _anthropic_client(api_key: str):
    key = f"anthropic|{api_key[:8]}"
    cache = _tls.__dict__.setdefault("clients", {})
    if key not in cache:
        import anthropic as sdk
        cache[key] = sdk.Anthropic(api_key=api_key)
    return cache[key]


def pdf_page_count(pdf_bytes: bytes) -> int:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return len(doc)
    finally:
        doc.close()


# ── AI call helpers ───────────────────────────────────────────────────────────

def _b64(data: bytes) -> str:
    return base64.standard_b64encode(data).decode()


def _img(png: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _b64(png)}}


def _txt(text: str) -> dict:
    return {"type": "text", "text": text}


def _call(
    messages: list[dict],
    max_tokens: int,
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
) -> dict:
    """Unified call returning {text, input_tokens, output_tokens, latency_ms}."""
    t0 = time.monotonic()
    if provider == "bedrock":
        result = _bedrock(model, messages, max_tokens, aws_profile, aws_region)
    elif provider == "anthropic":
        result = _anthropic(model, messages, max_tokens, anthropic_api_key or "")
    else:
        raise ValueError(f"Unknown provider: {provider!r}")
    result["latency_ms"] = int((time.monotonic() - t0) * 1000)
    return result


def _bedrock(model, messages, max_tokens, profile, region):
    from botocore.exceptions import ClientError

    client = _bedrock_client(profile, region)
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": max_tokens, "messages": messages}
    for attempt in range(3):
        try:
            resp = client.invoke_model(modelId=model, body=json.dumps(body))
            data = json.loads(resp["body"].read())
            usage = data.get("usage", {})
            return {
                "text": data["content"][0]["text"].strip(),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            }
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("ThrottlingException", "ServiceUnavailableException") and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise


def _anthropic(model, messages, max_tokens, api_key):
    client = _anthropic_client(api_key)
    resp = client.messages.create(model=model, max_tokens=max_tokens, messages=messages)
    return {
        "text": resp.content[0].text.strip(),
        "input_tokens": resp.usage.input_tokens,
        "output_tokens": resp.usage.output_tokens,
    }


def _call_kwargs(cfg: dict) -> dict:
    """Extract provider kwargs from a config dict."""
    return {
        "provider": cfg.get("provider", cfg.get("extraction_provider", "bedrock")),
        "model": cfg.get("model", cfg.get("extraction_model", "eu.anthropic.claude-opus-4-7")),
        "aws_profile": cfg.get("aws_profile"),
        "aws_region": cfg.get("aws_region", "eu-north-1"),
        "anthropic_api_key": cfg.get("anthropic_api_key"),
    }


def _parse_mark_json(text: str) -> tuple[str, str]:
    """Parse a JSON {result, reasoning} response. Falls back to keyword search."""
    try:
        clean = re.sub(r"```(?:json)?\s*|\s*```", "", text).strip()
        data = json.loads(clean)
        r = data.get("result", "").lower()
        if r in ("pass", "fail"):
            return r, data.get("reasoning", "")
    except Exception:
        pass
    if re.search(r"\bpass\b", text, re.IGNORECASE):
        return "pass", text
    if re.search(r"\bfail\b", text, re.IGNORECASE):
        return "fail", text
    return "error", text


# ── IDENTITY ZONE ─────────────────────────────────────────────────────────────
# Receives header PDF bytes only. Never receives student work.

_STUDENT_ID_PROMPT = (
    "This page contains a handwritten student identifier. "
    "It is either a 9-digit student number, a 6-digit candidate number, or a plain text name. "
    "Return only the identifier — no quotes, no surrounding text."
)

_HEADER_MARK_PROMPT = (
    "A teaching assistant may have written a mark on this page. "
    "Look for 'P', 'PASS', 'F', or 'FAIL' (possibly circled, ticked, or stamped). "
    "If you can clearly see such a mark, respond with exactly one word: PASS or FAIL. "
    "If no clear mark is visible, respond with: NONE"
)


def extract_student_identifier(
    header_pdf_bytes: bytes,  # IDENTITY ZONE: header only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """Extract student identifier from a header PDF."""
    png = render_pdf_page(header_pdf_bytes, 0, dpi)
    resp = _call(
        messages=[{"role": "user", "content": [_img(png), _txt(_STUDENT_ID_PROMPT)]}],
        max_tokens=100,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    raw = resp["text"].strip()
    result: dict = {
        "raw": raw,
        "input_tokens": resp["input_tokens"],
        "output_tokens": resp["output_tokens"],
        "latency_ms": resp["latency_ms"],
    }
    if re.fullmatch(r"\d{9}", raw):
        result.update(StudentID=int(raw), CandidateNumber=None, Name=None)
    elif re.fullmatch(r"\d{6}", raw):
        result.update(StudentID=None, CandidateNumber=int(raw), Name=None)
    else:
        result.update(StudentID=None, CandidateNumber=None, Name=raw or None)
    return result


def extract_human_mark_header(
    header_pdf_bytes: bytes,  # IDENTITY ZONE: header only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """Extract TA pass/fail mark from a header PDF."""
    png = render_pdf_page(header_pdf_bytes, 0, dpi)
    resp = _call(
        messages=[{"role": "user", "content": [_img(png), _txt(_HEADER_MARK_PROMPT)]}],
        max_tokens=20,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    raw = resp["text"].strip().upper()
    mark = "pass" if ("PASS" in raw or raw == "P") else "fail" if ("FAIL" in raw or raw == "F") else None
    return {"mark": mark, "raw": raw, "input_tokens": resp["input_tokens"],
            "output_tokens": resp["output_tokens"], "latency_ms": resp["latency_ms"]}


# ── WORK ZONE ─────────────────────────────────────────────────────────────────
# Receives body/answer PDF bytes only. Never receives student identity.

_QID_REGEX = re.compile(r"Q\d-[0-9a-f]{1,3}-[0-9a-f]{8}", re.IGNORECASE)

_QID_PROMPT = (
    "This student worksheet has a question ID printed at the bottom of the page. "
    "Return it as plain text only, no decoration. Example: Q2-3a-4bc12d34"
)

_BODY_MARK_PROMPT = (
    "A teaching assistant may have written a mark on this student worksheet. "
    "Look for 'P', 'PASS', 'F', or 'FAIL' (possibly circled, ticked, or stamped). "
    "If you can clearly see such a mark, respond with exactly one word: PASS or FAIL. "
    "If no clear mark is visible, respond with: NONE"
)

_ONESHOT_PROMPT = (
    "You are marking a student's mathematics worksheet. "
    "The first image is the official answer sheet for this question variant. "
    "The second image is the student's submitted work. "
    "The student's answer is correct if it is mathematically equivalent to the answer sheet, "
    "regardless of notation or layout. Students may write corrections anywhere on the page — "
    "look at all written work, not only designated answer boxes. "
    'Respond with exactly this JSON: {"result": "pass" or "fail", "reasoning": "one sentence"}'
)

_TWOSTEP_EXTRACT_PROMPT = (
    "You are looking at an official mathematics answer sheet for a specific question variant. "
    "Extract and describe the complete correct answer with all numerical values, "
    "algebraic expressions, steps, and notation needed to verify a student's response."
)

_TWOSTEP_MARK_PROMPT = (
    "You are marking a student's mathematics worksheet. "
    "The correct answer for this question is:\n{correct_answer}\n\n"
    "Examine the student's work in the image. Their answer is correct if it is "
    "mathematically equivalent to the correct answer, regardless of notation or layout. "
    "Students may write corrections anywhere on the page. "
    'Respond with exactly this JSON: {{"result": "pass" or "fail", "reasoning": "one sentence"}}'
)


def extract_question_id(
    body_pdf_bytes: bytes,  # WORK ZONE: body only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """Extract question ID from the last page of a body PDF."""
    n = pdf_page_count(body_pdf_bytes)
    png = render_pdf_page(body_pdf_bytes, n - 1, dpi)
    resp = _call(
        messages=[{"role": "user", "content": [_img(png), _txt(_QID_PROMPT)]}],
        max_tokens=80,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    raw = resp["text"].strip()
    m = _QID_REGEX.search(raw)
    normalized = m.group(0).lower().replace("q", "Q", 1) if m else None
    return {"question_id": normalized, "raw": raw,
            "input_tokens": resp["input_tokens"], "output_tokens": resp["output_tokens"],
            "latency_ms": resp["latency_ms"]}


def extract_human_mark_body(
    body_pdf_bytes: bytes,  # WORK ZONE: body only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """Extract TA pass/fail mark from a body PDF."""
    png = render_pdf_page(body_pdf_bytes, 0, dpi)
    resp = _call(
        messages=[{"role": "user", "content": [_img(png), _txt(_BODY_MARK_PROMPT)]}],
        max_tokens=20,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    raw = resp["text"].strip().upper()
    mark = "pass" if ("PASS" in raw or raw == "P") else "fail" if ("FAIL" in raw or raw == "F") else None
    return {"mark": mark, "raw": raw, "input_tokens": resp["input_tokens"],
            "output_tokens": resp["output_tokens"], "latency_ms": resp["latency_ms"]}


def ai_mark_oneshot(
    answer_pdf_bytes: bytes,  # WORK ZONE: answer only
    body_pdf_bytes: bytes,    # WORK ZONE: student work only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """One call: answer sheet + student work → pass/fail."""
    answer_png = render_pdf_page(answer_pdf_bytes, 0, dpi)
    body_png = render_pdf_page(body_pdf_bytes, 0, dpi)
    resp = _call(
        messages=[{"role": "user", "content": [
            _img(answer_png), _txt("Official answer sheet:"),
            _img(body_png), _txt("Student work:\n\n" + _ONESHOT_PROMPT),
        ]}],
        max_tokens=300,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    result, reasoning = _parse_mark_json(resp["text"])
    return {"result": result, "reasoning": reasoning, "raw_response": resp["text"],
            "step1_result": None, "input_tokens": resp["input_tokens"],
            "output_tokens": resp["output_tokens"], "latency_ms": resp["latency_ms"]}


def ai_mark_twostep(
    answer_pdf_bytes: bytes,  # WORK ZONE: answer only
    body_pdf_bytes: bytes,    # WORK ZONE: student work only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """Two calls: extract correct answer, then compare to student work."""
    answer_png = render_pdf_page(answer_pdf_bytes, 0, dpi)
    body_png = render_pdf_page(body_pdf_bytes, 0, dpi)

    step1 = _call(
        messages=[{"role": "user", "content": [_img(answer_png), _txt(_TWOSTEP_EXTRACT_PROMPT)]}],
        max_tokens=600,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    correct_answer = step1["text"]

    step2 = _call(
        messages=[{"role": "user", "content": [
            _img(body_png),
            _txt(_TWOSTEP_MARK_PROMPT.format(correct_answer=correct_answer)),
        ]}],
        max_tokens=300,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    result, reasoning = _parse_mark_json(step2["text"])
    return {
        "result": result, "reasoning": reasoning, "raw_response": step2["text"],
        "step1_result": correct_answer,
        "input_tokens": step1["input_tokens"] + step2["input_tokens"],
        "output_tokens": step1["output_tokens"] + step2["output_tokens"],
        "latency_ms": step1["latency_ms"] + step2["latency_ms"],
    }


def ai_mark_answer_sheet(
    answer_pdf_bytes: bytes,  # WORK ZONE: answer only
    body_pdf_bytes: bytes,    # WORK ZONE: student work only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    dpi: int = 150,
) -> dict:
    """
    Answer-sheet approach: answer PDF is looked up by question_id (done in the caller),
    then compared using the two-step method. Kept separate for logging/comparison.
    """
    return ai_mark_twostep(
        answer_pdf_bytes, body_pdf_bytes,
        provider, model, aws_profile, aws_region, anthropic_api_key, dpi,
    )
