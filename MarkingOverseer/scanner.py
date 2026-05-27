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
import logging
import re
import threading
import time

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)


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


# ── AI client cache ────────────────────────────────────────────────────────────
# boto3 Sessions are shared at the module level (one per profile) so that SSO
# credentials are loaded exactly once. Each thread then creates its own Client
# from the shared Session — Clients are not thread-safe but Sessions are, and
# credential state lives on the Session so subsequent threads skip the SSO file
# lock entirely once the first thread has loaded the token.
#
# _ensure_creds_initialized() additionally serialises the very first credential
# fetch so that the botocore tmp→rename write to ~/.aws/sso/cache/ never races
# across threads. On Windows that rename raises WinError 5 when concurrent.

_sessions: dict[str, object] = {}
_sessions_lock = threading.Lock()
_tls = threading.local()

_cred_init_done: set[str] = set()
_cred_init_lock = threading.Lock()


def _get_session(profile: str | None):
    key = str(profile)
    with _sessions_lock:
        if key not in _sessions:
            import boto3
            _sessions[key] = boto3.Session(profile_name=profile) if profile else boto3.Session()
        return _sessions[key]


def _ensure_creds_initialized(profile: str | None, region: str) -> None:
    """Serialise the first SSO credential fetch to avoid WinError 5.

    botocore writes the credential cache via temp-rename; on Windows that
    fails when multiple threads do it simultaneously. Calling
    get_frozen_credentials() once under a lock triggers the write; all
    subsequent calls find credentials in memory and skip the disk write.
    """
    key = f"{profile}|{region}"
    if key in _cred_init_done:
        return
    with _cred_init_lock:
        if key in _cred_init_done:
            return
        try:
            creds = _get_session(profile).get_credentials()
            if creds:
                creds.get_frozen_credentials()
        except Exception:
            pass
        _cred_init_done.add(key)


def _bedrock_client(profile: str | None, region: str):
    key = f"bedrock|{profile}|{region}"
    cache = _tls.__dict__.setdefault("clients", {})
    if key not in cache:
        _ensure_creds_initialized(profile, region)
        cache[key] = _get_session(profile).client("bedrock-runtime", region_name=region)
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


def _pdf(data: bytes) -> dict:
    return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": _b64(data)}}


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


def _to_converse_content(content: list[dict]) -> list[dict]:
    """Translate Anthropic Messages-format content blocks to Bedrock Converse format."""
    out = []
    doc_idx = 0
    for block in content:
        t = block.get("type")
        if t == "text":
            out.append({"text": block["text"]})
        elif t == "image":
            src = block["source"]
            if src.get("type") == "base64":
                raw = base64.standard_b64decode(src["data"])
                fmt = src["media_type"].split("/")[-1]
                out.append({"image": {"format": fmt, "source": {"bytes": raw}}})
        elif t == "document":
            src = block["source"]
            if src.get("type") == "base64":
                raw = base64.standard_b64decode(src["data"])
                doc_idx += 1
                out.append({"document": {"format": "pdf", "name": f"document-{doc_idx}", "source": {"bytes": raw}}})
    return out


def _bedrock(model, messages, max_tokens, profile, region):
    # All Bedrock models use the Converse API. The Converse API transmits document
    # and image content as raw bytes rather than base64-inside-JSON, avoiding the
    # invoke_model 20 MB body limit that causes "malformed JSON" errors when sending
    # two large PDFs (answer_sheet approach). It is also model-agnostic, so no
    # recoding is needed when adding new model families.
    return _bedrock_converse(model, messages, max_tokens, profile, region)


def _bedrock_converse(model, messages, max_tokens, profile, region):
    """Bedrock Converse API — model-agnostic path for Nova, Titan, Llama, Mistral, etc."""
    from botocore.exceptions import ClientError

    client = _bedrock_client(profile, region)
    converse_messages = [
        {"role": m["role"], "content": _to_converse_content(m["content"])}
        for m in messages
    ]
    for attempt in range(3):
        logger.info("Bedrock converse [model=%s region=%s attempt=%d max_tokens=%d]", model, region, attempt + 1, max_tokens)
        try:
            resp = client.converse(
                modelId=model,
                messages=converse_messages,
                inferenceConfig={"maxTokens": max_tokens},
            )
            content = resp["output"]["message"]["content"]
            text = next((b["text"] for b in content if "text" in b), "").strip()
            usage = resp.get("usage", {})
            in_tok = usage.get("inputTokens", 0)
            out_tok = usage.get("outputTokens", 0)
            logger.info("Bedrock converse ok [model=%s in=%d out=%d] response=%r", model, in_tok, out_tok, text[:200])
            return {"text": text, "input_tokens": in_tok, "output_tokens": out_tok}
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            msg = e.response.get("Error", {}).get("Message", str(e))
            if code in ("ThrottlingException", "ServiceUnavailableException") and attempt < 2:
                logger.warning("Bedrock converse throttle [model=%s region=%s attempt=%d]: %s", model, region, attempt + 1, msg)
                time.sleep(2 ** attempt)
                continue
            logger.error("Bedrock converse error [model=%s region=%s]: %s %s", model, region, code, msg)
            raise
        except Exception as e:
            logger.error("Bedrock converse error [model=%s region=%s]: %s: %s", model, region, type(e).__name__, e)
            raise


def _anthropic(model, messages, max_tokens, api_key):
    client = _anthropic_client(api_key)
    logger.info("Anthropic invoke [model=%s max_tokens=%d]", model, max_tokens)
    try:
        resp = client.messages.create(model=model, max_tokens=max_tokens, messages=messages)
        text = resp.content[0].text.strip()
        logger.info("Anthropic ok [model=%s in=%d out=%d] response=%r", model, resp.usage.input_tokens, resp.usage.output_tokens, text[:200])
        return {
            "text": text,
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
        }
    except Exception as e:
        logger.error("Anthropic error [model=%s]: %s: %s", model, type(e).__name__, e)
        raise


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
    """Extract pass/fail from a response that may contain reasoning before the JSON.

    Searches backward through all balanced {…} blocks for the last one that
    parses as valid JSON containing a 'result' field.
    """
    clean = re.sub(r"```(?:json)?\s*|\s*```", "", text)

    # Collect all top-level balanced {...} blocks
    blocks: list[str] = []
    for m in re.finditer(r"\{", clean):
        start, depth = m.start(), 0
        for j, c in enumerate(clean[start:]):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    blocks.append(clean[start : start + j + 1])
                    break

    # Try from last block to first (JSON is asked to appear at the end)
    for block in reversed(blocks):
        try:
            data = json.loads(block)
            r = data.get("result", "").lower()
            if r in ("pass", "fail"):
                return r, data.get("reasoning", "")
        except json.JSONDecodeError:
            continue

    # Keyword fallback
    if re.search(r"\bpass\b", text, re.IGNORECASE):
        return "pass", text
    if re.search(r"\bfail\b", text, re.IGNORECASE):
        return "fail", text
    logger.warning("Cannot parse pass/fail from AI response: %r", text[:500])
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
    prompt: str | None = None,
) -> dict:
    """Extract student identifier from a header PDF."""
    resp = _call(
        messages=[{"role": "user", "content": [_pdf(header_pdf_bytes), _txt(prompt or _STUDENT_ID_PROMPT)]}],
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
    prompt: str | None = None,
) -> dict:
    """Extract TA pass/fail mark from a header PDF."""
    resp = _call(
        messages=[{"role": "user", "content": [_pdf(header_pdf_bytes), _txt(prompt or _HEADER_MARK_PROMPT)]}],
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
    "This student worksheet has a question ID printed at the bottom of the last page. "
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
    "The worksheet shows the printed question and the student's handwritten work. "
    "Mark as pass if the student's answer is mathematically correct, fail if incorrect. "
    "Students may write corrections anywhere on the page — consider all written work.\n\n"
    "Reason through your marking, then finish your response with this JSON on its own line:\n"
    '{"result": "pass" or "fail", "reasoning": "one sentence summary"}'
)

_TWOSTEP_EXTRACT_PROMPT = (
    "You are looking at a student's mathematics worksheet. "
    "The printed question appears on this document. "
    "Extract and describe the complete correct answer to the question, "
    "with all numerical values, algebraic expressions, steps, and notation "
    "needed to verify a student's response. Ignore the student's handwriting for now."
)

_TWOSTEP_MARK_PROMPT = (
    "You are marking a student's mathematics worksheet. "
    "The correct answer for this question is:\n{correct_answer}\n\n"
    "Examine the student's work. Their answer is correct if it is "
    "mathematically equivalent to the correct answer, regardless of notation or layout. "
    "Students may write corrections anywhere on the page.\n\n"
    "Reason through your marking, then finish your response with this JSON on its own line:\n"
    '{{"result": "pass" or "fail", "reasoning": "one sentence summary"}}'
)

_ANSWER_SHEET_MARK_PROMPT = (
    "You have two documents. The first is the official answer sheet for a mathematics question. "
    "The second is a student's worksheet showing their attempt at the same question.\n\n"
    "Mark the student's work as pass if their answer is mathematically correct according to the "
    "answer sheet, fail if it is not. Mathematical equivalence is sufficient — notation and layout "
    "do not matter. Students may write corrections anywhere on the page.\n\n"
    "Reason through your marking using the answer sheet, then finish your response with this JSON on its own line:\n"
    '{"result": "pass" or "fail", "reasoning": "one sentence summary"}'
)


def extract_question_id(
    body_pdf_bytes: bytes,  # WORK ZONE: body only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    prompt: str | None = None,
) -> dict:
    """Extract question ID from a body PDF (printed in the footer of the last page)."""
    resp = _call(
        messages=[{"role": "user", "content": [_pdf(body_pdf_bytes), _txt(prompt or _QID_PROMPT)]}],
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
    prompt: str | None = None,
) -> dict:
    """Extract TA pass/fail mark from a body PDF."""
    resp = _call(
        messages=[{"role": "user", "content": [_pdf(body_pdf_bytes), _txt(prompt or _BODY_MARK_PROMPT)]}],
        max_tokens=20,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    raw = resp["text"].strip().upper()
    mark = "pass" if ("PASS" in raw or raw == "P") else "fail" if ("FAIL" in raw or raw == "F") else None
    return {"mark": mark, "raw": raw, "input_tokens": resp["input_tokens"],
            "output_tokens": resp["output_tokens"], "latency_ms": resp["latency_ms"]}


def ai_mark_oneshot(
    body_pdf_bytes: bytes,    # WORK ZONE: student work (question printed on sheet)
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    prompt: str | None = None,
) -> dict:
    """One call: worksheet containing the question and student work → pass/fail."""
    resp = _call(
        messages=[{"role": "user", "content": [_pdf(body_pdf_bytes), _txt(prompt or _ONESHOT_PROMPT)]}],
        max_tokens=8192,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    result, reasoning = _parse_mark_json(resp["text"])
    return {"result": result, "reasoning": reasoning, "raw_response": resp["text"],
            "step1_result": None, "input_tokens": resp["input_tokens"],
            "output_tokens": resp["output_tokens"], "latency_ms": resp["latency_ms"]}


def ai_mark_twostep(
    body_pdf_bytes: bytes,    # WORK ZONE: student work (question printed on sheet)
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    extract_prompt: str | None = None,
    mark_prompt: str | None = None,
) -> dict:
    """Two calls: derive correct answer from printed question, then mark student work."""
    body_doc = _pdf(body_pdf_bytes)

    step1 = _call(
        messages=[{"role": "user", "content": [body_doc, _txt(extract_prompt or _TWOSTEP_EXTRACT_PROMPT)]}],
        max_tokens=600,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    correct_answer = step1["text"]

    step2 = _call(
        messages=[{"role": "user", "content": [
            body_doc,
            _txt((mark_prompt or _TWOSTEP_MARK_PROMPT).format(correct_answer=correct_answer)),
        ]}],
        max_tokens=8192,
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
    answer_pdf_bytes: bytes,  # WORK ZONE: answer sheet PDF (looked up by QID)
    body_pdf_bytes: bytes,    # WORK ZONE: student work only
    provider: str,
    model: str,
    aws_profile: str | None = None,
    aws_region: str = "eu-north-1",
    anthropic_api_key: str | None = None,
    prompt: str | None = None,
) -> dict:
    """Single call: answer sheet + student worksheet → pass/fail.

    Both PDFs are sent together so the model can directly compare the student's
    work against the model answer without an intermediate extraction step.
    """
    resp = _call(
        messages=[{"role": "user", "content": [
            _pdf(answer_pdf_bytes),
            _pdf(body_pdf_bytes),
            _txt(prompt or _ANSWER_SHEET_MARK_PROMPT),
        ]}],
        max_tokens=8192,
        provider=provider, model=model,
        aws_profile=aws_profile, aws_region=aws_region, anthropic_api_key=anthropic_api_key,
    )
    result, reasoning = _parse_mark_json(resp["text"])
    return {
        "result": result, "reasoning": reasoning, "raw_response": resp["text"],
        "step1_result": None,
        "input_tokens": resp["input_tokens"],
        "output_tokens": resp["output_tokens"],
        "latency_ms": resp["latency_ms"],
    }
