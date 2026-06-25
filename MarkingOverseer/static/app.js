/* app.js — Marking Overseer SPA */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
  currentView: 'matrix',
  matrix: null,        // {students: [], questions: []}
  reviewStudent: null, // student_key string
  reviewQuestion: null,
  reviewData: null,    // api response
  reviewFilter: null,  // {items: [{student_key, question}], label} or null
  reviewFilterIdx: 0,
  reviewFocusAttempt: null, // attempt_id to scroll to after next render
  config: null,
  questions: window.INIT ? window.INIT.questions : [],
  markingModels: [],   // [{provider, model, label, enabled}]
  jobPolls: {},        // prefix → intervalId
  jobIds: {},          // prefix → jid
};

// ── Utilities ─────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}

function chip(status) {
  const labels = {
    pass: '✓ Pass', fail: '✗ Fail', pending: '… Pending',
    not_attempted: '—', not_marked: '?',
  };
  return `<span class="chip chip-${status}">${labels[status] || status}</span>`;
}

function fmt(n) { return n == null ? '—' : n; }
function fmtCost(c) { return c < 0.001 ? '<$0.001' : '$' + c.toFixed(4); }
function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }

// ── Navigation ────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const v = document.getElementById('v-' + name);
  const b = document.getElementById('nb-' + name);
  if (v) v.classList.add('active');
  if (b) b.classList.add('active');
  state.currentView = name;

  if (name === 'matrix') loadMatrix();
  if (name === 'import') loadStudentList();
  if (name === 'stats') { loadStats(); loadAttemptDetail(); }
  if (name === 'jobs') { populateJobSelects(); loadMarkingModels(); }
  if (name === 'review') {
    if (!state.matrix) {
      loadMatrix().then(() => populateReviewSelects(state.reviewStudent, state.reviewQuestion));
    } else {
      populateReviewSelects(state.reviewStudent, state.reviewQuestion);
    }
  }
}

// ── Matrix view ───────────────────────────────────────────────────────────────

async function loadMatrix() {
  try {
    const data = await api('GET', '/api/matrix');
    state.matrix = data;
    renderMatrix(data);
  } catch (e) {
    document.getElementById('matrix-container').innerHTML =
      `<div class="empty">Error loading dashboard: ${e.message}</div>`;
  }
}

function renderMatrix(data) {
  const { students, questions } = data;

  // Summary
  const passed = students.filter(s => s.all_passed).length;
  const total = students.length;
  document.getElementById('matrix-summary').textContent =
    `${total} students  ·  ${passed} completed all questions`;

  if (!students.length) {
    document.getElementById('matrix-container').innerHTML =
      '<div class="empty">No records found. Run the pipeline to extract data.</div>';
    return;
  }

  // Column totals
  const qtotals = {};
  for (const q of questions) {
    qtotals[q] = students.filter(s => s.question_status[q] === 'pass').length;
  }

  let html = '<table class="matrix"><thead><tr>';
  html += '<th>Student</th>';
  for (const q of questions) {
    html += `<th style="text-align:center">${q}<br><span class="muted">${qtotals[q]}/${total}</span></th>`;
  }
  html += '<th style="text-align:center">Progress</th></tr></thead><tbody>';

  for (const s of students) {
    html += `<tr>`;
    html += `<td>
      <button class="matrix-cell-btn" style="text-align:left;padding:4px 2px;width:auto" onclick="openStudentEdit('${esc(s.student_key)}')">
        <div style="font-weight:600;font-size:13px;color:#7ecfff;text-decoration:underline dotted">${esc(s.display_name)}</div>
        <div class="muted">${esc(String(s.StudentID || s.CandidateNumber || ''))}</div>
      </button>
    </td>`;

    for (const q of questions) {
      const status = s.question_status[q] || 'not_attempted';
      const files = (s.question_files[q] || []);
      const conflicts = files.some(f => f.human_mark_conflict);
      // Check AI vs TA disagreement
      let aiTaConflict = false;
      for (const f of files) {
        if (!f.human_mark_header) continue;
        if (f.attempts.some(a => !a.rejected && a.result && a.result !== 'error' && a.result !== f.human_mark_header)) {
          aiTaConflict = true; break;
        }
      }
      html += `<td style="text-align:center">
        <button class="matrix-cell-btn" onclick="openReview('${esc(s.student_key)}','${q}')">
          ${chip(status)}
          ${conflicts ? '<span class="tag-conflict" title="Human mark conflict">⚠</span>' : ''}
          ${aiTaConflict ? '<span style="font-size:10px;color:#fcc419" title="AI/TA disagreement">⚡</span>' : ''}
        </button>
      </td>`;
    }

    const pct = questions.length ? Math.round(s.total_passed / questions.length * 100) : 0;
    html += `<td style="text-align:center">
      <span class="badge">${s.total_passed}/${questions.length}</span>
      <div class="progress-bar" style="width:80px;margin:4px auto 0">
        <div class="progress-fill ${s.all_passed ? 'done' : ''}" style="width:${pct}%"></div>
      </div>
    </td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  document.getElementById('matrix-container').innerHTML = html;
}

// ── Review view ───────────────────────────────────────────────────────────────

function openReview(studentKey, question) {
  if (state.reviewFilter) {
    const idx = state.reviewFilter.items.findIndex(
      it => it.student_key === studentKey && it.question === question
    );
    if (idx >= 0) state.reviewFilterIdx = idx;
  }
  state.reviewStudent = studentKey;
  state.reviewQuestion = question;
  showView('review');
  populateReviewSelects(studentKey, question);
  loadReview(studentKey, question);
  renderFilteredReviewNav();
}

function populateReviewSelects(activeKey, activeQ) {
  const sel = document.getElementById('review-student-select');
  const qsel = document.getElementById('review-question-select');

  if (state.matrix && state.matrix.students.length) {
    sel.innerHTML = state.matrix.students.map(s =>
      `<option value="${esc(s.student_key)}" ${s.student_key === activeKey ? 'selected' : ''}>
        ${esc(s.display_name)}
      </option>`
    ).join('');
  }

  const qs = state.questions.length ? state.questions :
    (state.matrix ? state.matrix.questions : []);
  qsel.innerHTML = qs.map(q =>
    `<option value="${q}" ${q === activeQ ? 'selected' : ''}>${q}</option>`
  ).join('');
}

function onStudentSelect() {
  const sk = document.getElementById('review-student-select').value;
  const q = document.getElementById('review-question-select').value;
  if (sk && q) loadReview(sk, q);
}

function onQuestionSelect() {
  const sk = document.getElementById('review-student-select').value;
  const q = document.getElementById('review-question-select').value;
  if (sk && q) loadReview(sk, q);
}

async function loadReview(studentKey, question) {
  const body = document.getElementById('review-body');
  body.innerHTML = '<div class="empty">Loading…</div>';

  // Update title with student name
  if (state.matrix) {
    const s = state.matrix.students.find(s => s.student_key === studentKey);
    if (s) {
      document.getElementById('review-title').textContent =
        `Review — ${s.display_name} / ${question}`;
    }
  }

  try {
    const data = await api('GET', `/api/review/${encodeURIComponent(studentKey)}/${question}`);
    state.reviewData = data;
    renderReview(data, studentKey, question);

    if (state.reviewFocusAttempt) {
      const target = document.getElementById('attempt-' + state.reviewFocusAttempt);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid #7ecfff';
        target.style.transition = 'outline .5s';
        setTimeout(() => { target.style.outline = ''; }, 3000);
      }
      state.reviewFocusAttempt = null;
    }

    renderPendingMermaid();
  } catch (e) {
    body.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function renderReview(data, studentKey, question) {
  const { file_records, override } = data;
  let html = '';

  // Override panel
  html += `<div class="card">
    <div class="card-title">Manual Override</div>
    <div class="row">
      <span class="muted">Current: </span>${chip(override || computeResolvedFromFiles(file_records))}
      <div class="spacer"></div>
      <select class="input btn-sm" id="override-val" style="max-width:150px">
        <option value="">No override</option>
        <option value="pass" ${override === 'pass' ? 'selected' : ''}>Pass</option>
        <option value="fail" ${override === 'fail' ? 'selected' : ''}>Fail</option>
        <option value="pending" ${override === 'pending' ? 'selected' : ''}>Pending (reset)</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="saveOverride('${esc(studentKey)}','${question}')">Apply</button>
    </div>
  </div>`;

  if (!file_records.length) {
    html += '<div class="empty">No records found for this student and question.</div>';
    document.getElementById('review-body').innerHTML = html;
    return;
  }

  for (const fr of file_records) {
    html += renderFileRecord(fr, studentKey, question);
  }

  document.getElementById('review-body').innerHTML = html;
}

function computeResolvedFromFiles(file_records) {
  if (file_records.some(f => f.resolved === 'pass')) return 'pass';
  if (file_records.some(f => f.resolved === 'fail')) return 'fail';
  if (file_records.some(f => f.resolved === 'pending')) return 'pending';
  return 'not_attempted';
}

function renderFileRecord(fr, studentKey, question) {
  let html = `<div class="card">
    <div class="row" style="margin-bottom:12px">
      <div>
        <div class="text-sm" style="font-weight:600">File ID: <code>${fr.file_id}</code></div>
        <div class="muted">QID: <code>${fr.question_id || '—'}</code></div>
      </div>
      <div class="spacer"></div>
      ${chip(fr.resolved)}
    </div>`;

  // Human marks
  html += `<div class="row text-sm" style="margin-bottom:12px;gap:16px">
    <span>TA mark (body): ${fr.human_mark_body ? chip(fr.human_mark_body) : '<span class="muted">none</span>'}</span>
    <span>TA mark (header): ${fr.human_mark_header ? chip(fr.human_mark_header) : '<span class="muted">none</span>'}</span>
    ${fr.human_mark_conflict ? '<span class="tag-conflict">⚠ Conflict</span>' : ''}
  </div>`;

  // Model comparison
  const markEntries = {};
  if (fr.human_mark_header) markEntries['TA'] = fr.human_mark_header;
  for (const a of [...fr.attempts].reverse()) {
    if (a.rejected || !a.result || a.result === 'error') continue;
    const key = `${esc(a.model_label || a.model)} (${esc(a.ai_approach)})`;
    if (!markEntries[key]) markEntries[key] = a.result;
  }
  if (Object.keys(markEntries).length > 0) {
    const vals = Object.values(markEntries);
    const unanimous = vals.length > 1 && vals.every(r => r === vals[0]);
    const hasConflict = vals.length > 1 && !unanimous;
    html += `<div style="background:${hasConflict ? '#2a1a1a' : '#0f0f1a'};border:1px solid ${hasConflict ? '#7a2a2a' : '#2a2a3e'};border-radius:6px;padding:10px;margin-bottom:12px">
      <div class="muted" style="font-size:11px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">${hasConflict ? '⚡ Disagreement' : 'Model Agreement'}</div>
      <div class="row" style="flex-wrap:wrap;gap:10px">`;
    for (const [label, result] of Object.entries(markEntries)) {
      html += `<span class="text-sm"><span style="color:#888">${label}:</span> ${chip(result)}</span>`;
    }
    html += `</div></div>`;
  }

  // Images
  const pageCount = fr.body_page_count || 1;
  let bodyImgs = '';
  for (let pg = 0; pg < pageCount; pg++) {
    bodyImgs += `<img class="pdf-img" style="margin-bottom:6px" src="${fr.body_image_url}?page=${pg}" alt="Student work page ${pg+1}"
      onerror="this.style.display='none'">`;
  }
  const ansPageCount = fr.answer_page_count || 1;
  let ansImgs = '';
  if (fr.answer_image_url) {
    for (let pg = 0; pg < ansPageCount; pg++) {
      ansImgs += `<img class="pdf-img" style="margin-bottom:6px" src="${fr.answer_image_url}?page=${pg}" alt="Answer sheet page ${pg+1}"
        onerror="this.style.display='none'">`;
    }
  }
  html += `<div class="review-grid" style="margin-bottom:14px">
    <div>
      <div class="muted" style="margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">${pageCount > 1 ? `Student Work (${pageCount} pages)` : 'Student Work'}</div>
      ${bodyImgs}
    </div>
    <div>
      <div class="muted" style="margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">${ansPageCount > 1 ? `Answer Sheet (${ansPageCount} pages)` : 'Answer Sheet'}</div>
      ${fr.answer_image_url ? ansImgs : '<div class="empty">No QID extracted yet</div>'}
    </div>
  </div>`;

  // AI attempts
  if (fr.attempts.length) {
    html += `<div class="card-title">AI Marking Attempts (${fr.attempts.length})</div>`;
    for (const a of fr.attempts) {
      html += renderAttempt(a);
    }
  } else {
    html += `<div class="muted text-sm">No AI marking attempts yet. Run AI Marking from the Pipeline tab.</div>`;
  }

  html += '</div>';
  return html;
}

function renderAttempt(a) {
  const rejected = a.rejected;
  const borderColor = rejected ? '#3a1a1a' : (a.result === 'pass' ? '#1a3a2a' : a.result === 'fail' ? '#3a1a1a' : '#2a2a3e');
  let html = `<div class="attempt-row" id="attempt-${esc(a.attempt_id || '')}" style="border-color:${borderColor};${rejected ? 'opacity:.5' : ''}">
    <div class="attempt-header">
      ${a.result ? chip(a.result) : '<span class="muted">—</span>'}
      <span class="attempt-label">${esc(a.model_label || a.model)}</span>
      <span class="badge">${esc(a.ai_approach)}</span>
      ${a.prompt_hash ? `<span class="badge" style="cursor:pointer;font-family:monospace" onclick="showPromptPopup('${a.prompt_hash}')" title="View prompt">⌨ ${a.prompt_hash.slice(0,6)}</span>` : ''}
      <span class="muted">${fmtMs(a.latency_ms)}  ${fmtCost(a.cost_usd)}</span>
      <span class="muted">${a.input_tokens}+${a.output_tokens} tok</span>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" onclick="toggleReject('${a.attempt_id}', ${!rejected})">
        ${rejected ? '↩ Restore' : '✕ Reject'}
      </button>
    </div>`;

  if (a.reasoning) {
    html += `<div class="reasoning">${esc(a.reasoning)}</div>`;
  }
  if (a.step1_result) {
    const label = (a.ai_approach === 'diagram' || a.ai_approach === 'diagram_hints')
      ? 'Extracted diagrams (Mermaid):'
      : 'Extracted answer (step 1):';
    html += `<div class="muted text-sm" style="margin-top:8px">${label}</div>
      <div class="step1-box">${esc(a.step1_result)}</div>`;
  }
  if ((a.ai_approach === 'diagram' || a.ai_approach === 'diagram_hints') && a.diagram_data) {
    let dd;
    try { dd = typeof a.diagram_data === 'string' ? JSON.parse(a.diagram_data) : a.diagram_data; }
    catch (_) { dd = null; }
    if (dd && Array.isArray(dd.diagrams) && dd.diagrams.length) {
      html += `<div style="margin-top:10px"><div class="muted text-sm" style="margin-bottom:6px">Rendered diagrams:</div>`;
      for (const d of dd.diagrams) {
        html += `<div style="margin-bottom:10px">
          <div class="muted" style="font-size:11px;margin-bottom:4px">${esc(d.label || 'Diagram')}</div>
          <div class="mermaid-pending" data-mermaid="${esc(d.mermaid || '')}"
            style="background:#1a1a28;border-radius:4px;padding:8px;min-height:40px;color:#666;font-size:12px">Rendering…</div>
        </div>`;
      }
      html += `</div>`;
    }
  }
  if (a.error) {
    html += `<div class="reasoning" style="color:#ff6b6b">Error: ${esc(a.error)}</div>`;
  }
  html += '</div>';
  return html;
}

async function saveOverride(studentKey, question) {
  const val = document.getElementById('override-val').value || null;
  try {
    await api('POST', `/api/review/${encodeURIComponent(studentKey)}/${question}/override`, { value: val });
    await loadReview(studentKey, question);
    if (state.currentView === 'matrix') loadMatrix();
  } catch (e) {
    alert('Error saving override: ' + e.message);
  }
}

async function toggleReject(attemptId, rejected) {
  try {
    await api('POST', `/api/attempt/${attemptId}/reject`, { rejected });
    await loadReview(state.reviewStudent, state.reviewQuestion);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function showPromptPopup(hash) {
  try {
    const history = await api('GET', '/api/prompts/history');
    const entry = history[hash];
    if (!entry) { alert(`Prompt hash ${hash} not found in history`); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:2000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `<div style="background:#161625;border:1px solid #2a2a3e;border-radius:10px;padding:20px;max-width:600px;width:90vw;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="font-weight:600;color:#e0e0e0">Prompt: ${esc(entry.key)} <span class="badge" style="font-family:monospace">${hash}</span></span>
        <button onclick="this.closest('div[style]').remove()" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px">✕</button>
      </div>
      <div class="muted" style="font-size:11px;margin-bottom:8px">Saved: ${esc(entry.saved_at || '')}</div>
      <pre style="background:#0f0f1a;padding:12px;border-radius:6px;font-size:12px;color:#e0e0e0;white-space:pre-wrap;word-break:break-word">${esc(entry.text)}</pre>
    </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ── Jobs view ─────────────────────────────────────────────────────────────────

function populateJobSelects() {
  const qs = state.questions;
  const opts = '<option value="">All questions</option>' +
    qs.map(q => `<option value="${q}">${q}</option>`).join('');
  ['j1', 'j2', 'j3', 'j4'].forEach(id => {
    const el = document.getElementById(id + '-questions');
    if (el) el.innerHTML = opts;
  });
  // filter-question in stats view
  const fq = document.getElementById('filter-question');
  if (fq) fq.innerHTML = opts;
}

async function loadMarkingModels() {
  try {
    const cfg = await api('GET', '/api/config');
    state.markingModels = cfg.marking_models || [];
    renderMarkingModelCheckboxes(state.markingModels);
  } catch (_) {}
}

function _savedModelIds() {
  try { return new Set(JSON.parse(localStorage.getItem('j4-selected-models') || 'null') || []); }
  catch (_) { return null; }
}

function _saveModelIds() {
  const ids = (state.markingModels || [])
    .filter((m, i) => document.getElementById(`j4-model-${i}`)?.checked)
    .map(m => m.model);
  localStorage.setItem('j4-selected-models', JSON.stringify(ids));
}

function renderMarkingModelCheckboxes(models) {
  const list = document.getElementById('j4-models-list');
  if (!list) return;
  if (!models.length) {
    list.innerHTML = '<span class="muted text-sm">No models configured — add models in Config</span>';
    return;
  }
  const saved = _savedModelIds();
  list.innerHTML = models.map((m, i) => {
    const checked = saved && saved.size ? saved.has(m.model) : m.enabled !== false;
    return `<label class="row" style="gap:4px;cursor:pointer">
      <input type="checkbox" id="j4-model-${i}" ${checked ? 'checked' : ''} onchange="_saveModelIds()">
      <span class="text-sm">${esc(m.label || m.model)}</span>
    </label>`;
  }).join('');
}

function _jobStarted(prefix, jid) {
  state.jobIds[prefix] = jid;
  const runBtn = document.getElementById(prefix + '-run');
  const stopBtn = document.getElementById(prefix + '-stop');
  if (runBtn) runBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
}

function _jobEnded(prefix) {
  const runBtn = document.getElementById(prefix + '-run');
  const stopBtn = document.getElementById(prefix + '-stop');
  if (runBtn) runBtn.disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
}

async function cancelJob(prefix) {
  const jid = state.jobIds[prefix];
  if (!jid) return;
  try {
    await api('POST', `/api/jobs/${jid}/cancel`);
  } catch (_) {}
}

async function runJob(endpoint, prefix) {
  const qSel = document.getElementById(prefix + '-questions');
  const q = qSel ? qSel.value : null;
  const force = document.getElementById(prefix + '-force')?.checked || false;
  const body = q ? { questions: [q] } : {};
  if (force) body.force = true;

  try {
    const r = await api('POST', `/api/jobs/${endpoint}`, body);
    _jobStarted(prefix, r.job_id);
    pollJob(r.job_id, prefix);
  } catch (e) {
    alert('Error starting job: ' + e.message);
  }
}

async function runAiMark() {
  const approaches = [];
  if (document.getElementById('a-oneshot').checked) approaches.push('oneshot');
  if (document.getElementById('a-twostep').checked) approaches.push('twostep');
  if (document.getElementById('a-answer_sheet').checked) approaches.push('answer_sheet');
  if (document.getElementById('a-diagram').checked) approaches.push('diagram');
  if (document.getElementById('a-diagram_hints').checked) approaches.push('diagram_hints');
  if (!approaches.length) { alert('Select at least one approach.'); return; }

  const selectedModels = (state.markingModels || [])
    .filter((m, i) => document.getElementById(`j4-model-${i}`)?.checked)
    .map(m => m.model);
  if (!selectedModels.length) { alert('Select at least one model.'); return; }

  const q = document.getElementById('j4-questions').value;
  const skip = document.getElementById('j4-skip').checked;
  const body = { approaches, skip_existing: skip, models: selectedModels };
  if (q) body.questions = [q];

  try {
    const r = await api('POST', '/api/jobs/ai_mark', body);
    _jobStarted('j4', r.job_id);
    pollJob(r.job_id, 'j4');
  } catch (e) {
    alert('Error starting AI mark: ' + e.message);
  }
}

function pollJob(jid, prefix) {
  const prog = document.getElementById(prefix + '-progress');
  const fill = document.getElementById(prefix + '-fill');
  const log = document.getElementById(prefix + '-log');
  if (prog) prog.style.display = 'block';

  if (state.jobPolls[prefix]) clearInterval(state.jobPolls[prefix]);

  state.jobPolls[prefix] = setInterval(async () => {
    try {
      const s = await api('GET', `/api/jobs/${jid}/status`);
      const pct = s.total > 0 ? (s.done / s.total * 100) : 0;
      if (fill) {
        fill.style.width = pct + '%';
        if (!s.running) fill.classList.add(s.errors > 0 ? 'error' : 'done');
      }
      if (log) log.textContent = s.log.slice(-40).join('\n');

      if (!s.running) {
        clearInterval(state.jobPolls[prefix]);
        delete state.jobPolls[prefix];
        _jobEnded(prefix);
        // Refresh questions list in case new folders appeared
        const qs = await api('GET', '/api/config/questions');
        state.questions = qs;
        populateJobSelects();
      }
    } catch (e) {
      clearInterval(state.jobPolls[prefix]);
      _jobEnded(prefix);
    }
  }, 1500);
}

// ── Import view ───────────────────────────────────────────────────────────────

async function importStudents() {
  const file = document.getElementById('import-file').files[0];
  if (!file) return;
  const status = document.getElementById('import-status');
  status.textContent = 'Uploading…';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/students/import', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    status.textContent = `✓ Imported ${data.imported} students (${data.total} total)`;
    loadStudentList();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
}

async function loadStudentList() {
  const body = document.getElementById('student-list-body');
  try {
    const data = await api('GET', '/api/students');
    document.getElementById('student-list-title').textContent =
      `Current student list (${data.count})`;

    if (!data.students.length) {
      body.innerHTML = '<div class="empty">No students imported yet.</div>';
      return;
    }

    let html = '<table class="stats-table"><thead><tr>';
    html += '<th>Name</th><th>StudentID</th><th>CandidateNumber</th><th>Email</th>';
    html += '</tr></thead><tbody>';
    for (const s of data.students) {
      html += `<tr>
        <td>${esc(s.Name || '—')}</td>
        <td><code>${esc(s.StudentID || '—')}</code></td>
        <td><code>${esc(s.CandidateNumber || '—')}</code></td>
        <td>${esc(s.Email || '—')}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

// ── Stats view ────────────────────────────────────────────────────────────────

let _statsData = null;
let _statsSort = { col: null, dir: 1 };

const _STATS_COLS = [
  { key: 'label',           label: 'Model / Approach' },
  { key: 'count',           label: 'Count' },
  { key: 'pass',            label: 'Pass' },
  { key: 'fail',            label: 'Fail' },
  { key: 'error',           label: 'Error' },
  { key: 'pass_rate',       label: 'Pass rate' },
  { key: 'avg_latency_ms',  label: 'Avg latency' },
  { key: 'avg_cost_usd',    label: 'Avg cost' },
  { key: 'total_cost_usd',  label: 'Total cost' },
  { key: 'prompt_hash',     label: 'Prompt' },
  { key: 'ta_correlation',  label: 'TA Corr.' },
  { key: 'false_positives', label: 'FP', title: 'False positives: AI=Pass, TA=Fail' },
  { key: 'false_negatives', label: 'FN', title: 'False negatives: AI=Fail, TA=Pass' },
];

function onStatsSortClick(col) {
  _statsSort = _statsSort.col === col
    ? { col, dir: _statsSort.dir * -1 }
    : { col, dir: 1 };
  if (_statsData) _renderStatsTable(document.getElementById('stats-summary'), _statsData);
}

function _renderStatsTable(el, data) {
  const { col, dir } = _statsSort;
  const sorted = col ? [...data].sort((a, b) => {
    const av = a[col] ?? null, bv = b[col] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  }) : data;

  let html = '<table class="stats-table"><thead><tr>';
  for (const c of _STATS_COLS) {
    const active = col === c.key;
    const arrow = active ? (dir === 1 ? ' ↑' : ' ↓') : '';
    const titleAttr = c.title ? ` title="${c.title}"` : '';
    html += `<th style="cursor:pointer;user-select:none${active ? ';color:#7ecfff' : ''}"
      onclick="onStatsSortClick('${c.key}')"${titleAttr}>${c.label}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const g of sorted) {
    const fp = g.false_positives || 0;
    const fn = g.false_negatives || 0;
    const fpCell = fp > 0
      ? `<button class="btn btn-ghost btn-sm" style="color:#fcc419;padding:2px 6px"
          data-model="${esc(g.model_label || g.label)}"
          data-approach="${esc(g.approach)}"
          data-prompt="${esc(g.prompt_hash || '')}"
          data-type="fp"
          onclick="event.stopPropagation();showDisagreements(this)">${fp}</button>`
      : `<span class="muted">${fp}</span>`;
    const fnCell = fn > 0
      ? `<button class="btn btn-ghost btn-sm" style="color:#fcc419;padding:2px 6px"
          data-model="${esc(g.model_label || g.label)}"
          data-approach="${esc(g.approach)}"
          data-prompt="${esc(g.prompt_hash || '')}"
          data-type="fn"
          onclick="event.stopPropagation();showDisagreements(this)">${fn}</button>`
      : `<span class="muted">${fn}</span>`;
    html += `<tr>
      <td><strong>${esc(g.label)}</strong></td>
      <td>${g.count}</td>
      <td style="color:#51cf66">${g.pass || 0}</td>
      <td style="color:#ff6b6b">${g.fail || 0}</td>
      <td style="color:#888">${g.error || 0}</td>
      <td>${(g.pass_rate * 100).toFixed(1)}%</td>
      <td>${fmtMs(g.avg_latency_ms)}</td>
      <td>${fmtCost(g.avg_cost_usd)}</td>
      <td>${fmtCost(g.total_cost_usd)}</td>
      <td>${g.prompt_hash ? `<span class="badge" style="cursor:pointer;font-family:monospace" onclick="event.stopPropagation();showPromptPopup('${g.prompt_hash}')">${g.prompt_hash.slice(0,6)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${g.ta_correlation != null ? `${(g.ta_correlation * 100).toFixed(1)}% (${g.ta_agree}/${g.ta_total})` : '<span class="muted">—</span>'}</td>
      <td>${fpCell}</td>
      <td>${fnCell}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function loadStats() {
  const el = document.getElementById('stats-summary');
  try {
    const stats = await api('GET', '/api/stats/attempts');
    if (!stats.length) { el.innerHTML = '<div class="empty">No attempts yet.</div>'; return; }
    _statsData = stats;
    _renderStatsTable(el, stats);
  } catch (e) {
    el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

let _attemptDetailData = null;
let _expandedAttemptIdx = null;

function _renderAttemptDetailTable(el) {
  const data = _attemptDetailData;
  if (!data || !data.length) {
    el.innerHTML = '<div class="empty">No attempts match filter.</div>';
    return;
  }
  let html = '<table class="stats-table"><thead><tr>';
  html += '<th>Time</th><th>File</th><th>QID</th><th>Q</th><th>Approach</th><th>Model</th>';
  html += '<th>Result</th><th>Latency</th><th>Cost</th><th>Rejected</th>';
  html += '</tr></thead><tbody>';
  for (let i = 0; i < data.length; i++) {
    const a = data[i];
    const ts = a.timestamp ? a.timestamp.slice(0, 19).replace('T', ' ') : '—';
    const expanded = _expandedAttemptIdx === i;
    html += `<tr style="cursor:pointer${expanded ? ';background:#131320' : ''}"
      onclick="toggleAttemptDetail(${i})" title="Click to ${expanded ? 'collapse' : 'expand'} details">
      <td>${esc(ts)}</td>
      <td><code style="font-size:11px">${esc((a.file_id || '').slice(0, 10))}</code></td>
      <td><code style="font-size:11px">${esc(a.question_id || '—')}</code></td>
      <td>${esc(a.question || '—')}</td>
      <td>${esc(a.ai_approach || '—')}</td>
      <td>${esc(a.model_label || a.model || '—')}</td>
      <td>${a.result ? chip(a.result) : '<span class="muted">—</span>'}</td>
      <td>${fmtMs(a.latency_ms || 0)}</td>
      <td>${fmtCost(a.cost_usd || 0)}</td>
      <td>${a.rejected ? '✕' : ''}</td>
    </tr>`;
    if (expanded) {
      html += `<tr><td colspan="10" style="padding:0">
        <div style="background:#0f0f1a;border-left:3px solid #7ecfff;padding:14px 16px;font-size:12px">
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:10px;color:#888;align-items:center">
          <span>ID: <code style="color:#aaa">${esc(a.attempt_id || '—')}</code></span>
          <span>${a.input_tokens || 0} in + ${a.output_tokens || 0} out tokens</span>
          ${a.prompt_hash ? `<span>Prompt: <span class="badge" style="cursor:pointer;font-family:monospace" onclick="event.stopPropagation();showPromptPopup('${esc(a.prompt_hash)}')">${esc(a.prompt_hash.slice(0,6))}</span></span>` : ''}
          ${a.rejected ? '<span style="color:#ff6b6b">REJECTED</span>' : ''}
          ${a.display_name ? `<span>Student: <span style="color:#e0e0e0">${esc(a.display_name)}</span></span>` : ''}
          ${a.student_key ? `<button class="btn btn-ghost btn-sm" style="padding:3px 8px"
            data-sk="${esc(a.student_key)}" data-q="${esc(a.question || '')}" data-aid="${esc(a.attempt_id || '')}"
            onclick="event.stopPropagation();reviewAttemptDirect(this)">Review →</button>` : ''}
        </div>`;
      if (a.error) {
        html += `<div style="color:#ff6b6b;margin-bottom:8px">Error: ${esc(a.error)}</div>`;
      }
      if (a.step1_result) {
        html += `<div class="muted" style="margin-bottom:4px">Step 1 extraction:</div>
          <pre style="background:#161625;padding:8px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-word;margin-bottom:10px;max-height:120px;overflow-y:auto;color:#e0e0e0">${esc(a.step1_result)}</pre>`;
      }
      if (a.reasoning) {
        html += `<div class="muted" style="margin-bottom:4px">Reasoning:</div>
          <pre style="background:#161625;padding:8px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-word;margin-bottom:10px;max-height:180px;overflow-y:auto;color:#e0e0e0">${esc(a.reasoning)}</pre>`;
      }
      if (a.raw_response) {
        html += `<div class="muted" style="margin-bottom:4px">Raw response:</div>
          <pre style="background:#161625;padding:8px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;color:#c0c0c0;font-size:11px">${esc(a.raw_response)}</pre>`;
      }
      if (!a.error && !a.reasoning && !a.raw_response && !a.step1_result) {
        html += '<div class="muted">No additional details available.</div>';
      }
      html += `</div></td></tr>`;
    }
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function toggleAttemptDetail(idx) {
  _expandedAttemptIdx = _expandedAttemptIdx === idx ? null : idx;
  const el = document.getElementById('stats-detail');
  if (el) _renderAttemptDetailTable(el);
}

async function loadAttemptDetail() {
  const el = document.getElementById('stats-detail');
  if (!el) return;
  const q = document.getElementById('filter-question')?.value || '';
  const ap = document.getElementById('filter-approach')?.value || '';
  const params = new URLSearchParams();
  if (q) params.set('question', q);
  if (ap) params.set('ai_approach', ap);
  try {
    const attempts = await api('GET', '/api/stats/attempts/detail?' + params);
    _attemptDetailData = [...attempts].reverse();
    _expandedAttemptIdx = null;
    _renderAttemptDetailTable(el);
  } catch (e) {
    el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function showDisagreements(btn) {
  const modelLabel = btn.dataset.model;
  const approach = btn.dataset.approach;
  const promptHash = btn.dataset.prompt;
  const type = btn.dataset.type;
  const typeLabel = type === 'fp'
    ? 'False Positives — AI said Pass, TA said Fail'
    : 'False Negatives — AI said Fail, TA said Pass';

  const overlay = document.createElement('div');
  overlay.className = 'disagreements-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:2000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:#161625;border:1px solid #2a2a3e;border-radius:10px;padding:20px;max-width:820px;width:92vw;max-height:85vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
      <div>
        <div style="font-weight:600;color:#e0e0e0">${esc(typeLabel)}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${esc(modelLabel)} / ${esc(approach)}${promptHash ? ` <span class="badge" style="font-family:monospace">${esc(promptHash.slice(0,6))}</span>` : ''}</div>
      </div>
      <button onclick="this.closest('.disagreements-overlay').remove()" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:18px;margin-left:16px;line-height:1">✕</button>
    </div>
    <div id="disagreements-body"><div class="empty">Loading…</div></div>
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  try {
    const params = new URLSearchParams({ model_label: modelLabel, approach, type, prompt_hash: promptHash });
    const items = await api('GET', '/api/stats/disagreements?' + params);
    const body = overlay.querySelector('#disagreements-body');
    if (!items.length) {
      body.innerHTML = '<div class="empty">No cases found.</div>';
      return;
    }
    let html = `<div class="row" style="margin-bottom:10px;align-items:center">
      <span class="muted" style="font-size:12px">${items.length} case${items.length !== 1 ? 's' : ''}</span>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm" id="review-all-btn">Review all →</button>
    </div>`;
    html += '<table class="stats-table" style="width:100%"><thead><tr>';
    html += '<th>Student</th><th>Question</th><th>AI</th><th>TA</th><th></th>';
    html += '</tr></thead><tbody>';
    for (const it of items) {
      html += `<tr>
        <td>${esc(it.display_name)}</td>
        <td>${esc(it.question)}</td>
        <td>${chip(it.ai_result)}</td>
        <td>${chip(it.ta_result)}</td>
        <td><button class="btn btn-ghost btn-sm"
          data-sk="${esc(it.student_key)}" data-q="${esc(it.question)}"
          onclick="closeAndReview(this)">Review →</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;
    const reviewAllBtn = body.querySelector('#review-all-btn');
    if (reviewAllBtn) {
      reviewAllBtn.addEventListener('click', () => {
        overlay.remove();
        startFilteredReview(items, typeLabel);
      });
    }
  } catch (e) {
    const body = overlay.querySelector('#disagreements-body');
    if (body) body.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

function closeAndReview(btn) {
  const sk = btn.dataset.sk;
  const q = btn.dataset.q;
  const overlay = btn.closest('.disagreements-overlay');
  if (overlay) overlay.remove();
  openReview(sk, q);
}

// ── Review filter (filtered review from disagreements) ────────────────────────

function renderFilteredReviewNav() {
  const banner = document.getElementById('review-filter-banner');
  if (!banner) return;
  if (!state.reviewFilter) {
    banner.style.display = 'none';
    return;
  }
  const { items, label } = state.reviewFilter;
  const idx = state.reviewFilterIdx;
  banner.style.display = 'flex';
  const labelEl = document.getElementById('review-filter-label');
  const posEl = document.getElementById('review-filter-pos');
  if (labelEl) labelEl.textContent = label;
  if (posEl) posEl.textContent = `${idx + 1} / ${items.length}`;
}

function reviewFilterPrev() {
  if (!state.reviewFilter) return;
  const items = state.reviewFilter.items;
  state.reviewFilterIdx = (state.reviewFilterIdx - 1 + items.length) % items.length;
  const it = items[state.reviewFilterIdx];
  openReview(it.student_key, it.question);
}

function reviewFilterNext() {
  if (!state.reviewFilter) return;
  const items = state.reviewFilter.items;
  state.reviewFilterIdx = (state.reviewFilterIdx + 1) % items.length;
  const it = items[state.reviewFilterIdx];
  openReview(it.student_key, it.question);
}

function clearReviewFilter() {
  state.reviewFilter = null;
  state.reviewFilterIdx = 0;
  renderFilteredReviewNav();
}

function startFilteredReview(items, label) {
  state.reviewFilter = {
    items: items.map(it => ({ student_key: it.student_key, question: it.question })),
    label,
  };
  state.reviewFilterIdx = 0;
  const first = state.reviewFilter.items[0];
  if (first) openReview(first.student_key, first.question);
}

function reviewAttemptDirect(btn) {
  const sk = btn.dataset.sk;
  const q = btn.dataset.q;
  const aid = btn.dataset.aid;
  state.reviewFocusAttempt = aid || null;
  openReview(sk, q);
}

// ── Mermaid rendering ─────────────────────────────────────────────────────────

async function renderPendingMermaid() {
  if (typeof mermaid === 'undefined') return;
  const nodes = document.querySelectorAll('.mermaid-pending[data-mermaid]');
  for (const node of nodes) {
    const code = node.dataset.mermaid;
    if (!code) continue;
    node.classList.remove('mermaid-pending');
    try {
      const id = 'mmd-' + Math.random().toString(36).slice(2, 10);
      const { svg } = await mermaid.render(id, code);
      node.innerHTML = svg;
    } catch (e) {
      node.style.color = '#ff6b6b';
      node.style.fontSize = '11px';
      node.textContent = 'Diagram render error: ' + (e.message || e);
    }
  }
}

// ── Config modal ──────────────────────────────────────────────────────────────

async function openConfig() {
  try {
    const [cfg, defs] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/api/prompts/defaults'),
    ]);
    state.config = cfg;
    state.promptDefaults = defs;
    document.getElementById('cfg-data-root').value = cfg.data_root || '';
    document.getElementById('cfg-answer-sheets-root').value = cfg.answer_sheets_root || '';
    document.getElementById('cfg-marked-scans-root').value = cfg.marked_scans_root || '';
    const orEl = document.getElementById('cfg-overseer-root');
    if (orEl) {
      orEl.value = cfg.overseer_root || '';
      const hint = document.getElementById('cfg-overseer-root-hint');
      if (hint) {
        hint.textContent = cfg.overseer_root
          ? `Using: ${cfg.overseer_root}`
          : 'Auto-detect from git repo (leave blank to use default)';
      }
    }
    document.getElementById('cfg-aws-profile').value = cfg.aws_profile || '';
    document.getElementById('cfg-aws-region').value = cfg.aws_region || '';
    document.getElementById('cfg-anthropic-key').value = cfg.anthropic_api_key || '';
    document.getElementById('cfg-extraction-provider').value = cfg.extraction_provider || 'bedrock';
    document.getElementById('cfg-extraction-model').value = cfg.extraction_model || '';
    document.getElementById('cfg-workers').value = cfg.parallel_workers || 4;
    document.getElementById('cfg-dpi').value = cfg.render_dpi || 150;
    document.getElementById('cfg-skip').checked = cfg.skip_existing !== false;
    renderMarkingModels(cfg.marking_models || []);
    const p = cfg.prompts || {};
    document.getElementById('cfg-prompt-student-id').value = p.student_id || defs.student_id || '';
    document.getElementById('cfg-prompt-header-mark').value = p.header_mark || defs.header_mark || '';
    document.getElementById('cfg-prompt-qid').value = p.qid || defs.qid || '';
    document.getElementById('cfg-prompt-body-mark').value = p.body_mark || defs.body_mark || '';
    document.getElementById('cfg-prompt-oneshot').value = p.oneshot || defs.oneshot || '';
    document.getElementById('cfg-prompt-twostep-extract').value = p.twostep_extract || defs.twostep_extract || '';
    document.getElementById('cfg-prompt-twostep-mark').value = p.twostep_mark || defs.twostep_mark || '';
    document.getElementById('cfg-prompt-answer-sheet').value = p.answer_sheet || defs.answer_sheet || '';
    const diagramPromptEl = document.getElementById('cfg-prompt-diagram');
    if (diagramPromptEl) diagramPromptEl.value = p.diagram || defs.diagram || '';
    const hintsEl = document.getElementById('cfg-diagram-hints');
    if (hintsEl) {
      const hints = cfg.question_diagram_hints || {};
      hintsEl.value = Object.keys(hints).length
        ? JSON.stringify(hints, null, 2)
        : '';
    }
    document.getElementById('config-modal').classList.add('open');
    loadLogs();
  } catch (e) {
    alert('Error loading config: ' + e.message);
  }
}

function renderMarkingModels(models) {
  const list = document.getElementById('marking-models-list');
  list.innerHTML = models.map((m, i) => `
    <div class="model-row" id="mrow-${i}">
      <input type="checkbox" ${m.enabled ? 'checked' : ''} id="m-enabled-${i}">
      <select class="input btn-sm" id="m-provider-${i}" style="max-width:140px">
        <option value="bedrock" ${m.provider === 'bedrock' ? 'selected' : ''}>Bedrock</option>
        <option value="anthropic" ${m.provider === 'anthropic' ? 'selected' : ''}>Anthropic API</option>
      </select>
      <input class="input btn-sm" id="m-model-${i}" value="${esc(m.model || '')}" placeholder="model ID" style="flex:1">
      <input class="input btn-sm" id="m-label-${i}" value="${esc(m.label || '')}" placeholder="label" style="max-width:160px">
      <button class="btn btn-ghost btn-sm" onclick="moveMarkingModel(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-ghost btn-sm" onclick="moveMarkingModel(${i}, 1)" ${i === models.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn btn-danger btn-sm" onclick="removeMarkingModel(${i})">✕</button>
    </div>
  `).join('');
}

function gatherMarkingModels() {
  const list = document.getElementById('marking-models-list');
  const rows = list.querySelectorAll('[id^="mrow-"]');
  const models = [];
  rows.forEach((row, i) => {
    models.push({
      enabled: document.getElementById(`m-enabled-${i}`)?.checked ?? true,
      provider: document.getElementById(`m-provider-${i}`)?.value || 'bedrock',
      model: document.getElementById(`m-model-${i}`)?.value.trim() || '',
      label: document.getElementById(`m-label-${i}`)?.value.trim() || '',
    });
  });
  return models.filter(m => m.model);
}

function addMarkingModel() {
  const current = gatherMarkingModels();
  current.push({ enabled: true, provider: 'bedrock', model: '', label: 'New model' });
  renderMarkingModels(current);
}

function removeMarkingModel(idx) {
  const current = gatherMarkingModels();
  current.splice(idx, 1);
  renderMarkingModels(current);
}

function moveMarkingModel(idx, dir) {
  const current = gatherMarkingModels();
  const target = idx + dir;
  if (target < 0 || target >= current.length) return;
  [current[idx], current[target]] = [current[target], current[idx]];
  renderMarkingModels(current);
}

function _promptVal(id, defaultKey) {
  const v = document.getElementById(id).value.trim();
  const def = (state.promptDefaults || {})[defaultKey] || '';
  return v === def ? '' : v;
}

async function saveConfig() {
  let questionDiagramHints = {};
  const hintsEl = document.getElementById('cfg-diagram-hints');
  if (hintsEl && hintsEl.value.trim()) {
    try { questionDiagramHints = JSON.parse(hintsEl.value.trim()); }
    catch (_) { alert('Per-question Mermaid hints must be valid JSON.'); return; }
  }
  const cfg = {
    data_root: document.getElementById('cfg-data-root').value.trim(),
    answer_sheets_root: document.getElementById('cfg-answer-sheets-root').value.trim(),
    marked_scans_root: document.getElementById('cfg-marked-scans-root').value.trim(),
    overseer_root: document.getElementById('cfg-overseer-root')?.value.trim() || '',
    question_diagram_hints: questionDiagramHints,
    aws_profile: document.getElementById('cfg-aws-profile').value.trim(),
    aws_region: document.getElementById('cfg-aws-region').value.trim(),
    anthropic_api_key: document.getElementById('cfg-anthropic-key').value.trim() || '***',
    extraction_provider: document.getElementById('cfg-extraction-provider').value,
    extraction_model: document.getElementById('cfg-extraction-model').value.trim(),
    parallel_workers: parseInt(document.getElementById('cfg-workers').value) || 4,
    render_dpi: parseInt(document.getElementById('cfg-dpi').value) || 150,
    skip_existing: document.getElementById('cfg-skip').checked,
    marking_models: gatherMarkingModels(),
    prompts: {
      student_id: _promptVal('cfg-prompt-student-id', 'student_id'),
      header_mark: _promptVal('cfg-prompt-header-mark', 'header_mark'),
      qid: _promptVal('cfg-prompt-qid', 'qid'),
      body_mark: _promptVal('cfg-prompt-body-mark', 'body_mark'),
      oneshot: _promptVal('cfg-prompt-oneshot', 'oneshot'),
      twostep_extract: _promptVal('cfg-prompt-twostep-extract', 'twostep_extract'),
      twostep_mark: _promptVal('cfg-prompt-twostep-mark', 'twostep_mark'),
      answer_sheet: _promptVal('cfg-prompt-answer-sheet', 'answer_sheet'),
      diagram: _promptVal('cfg-prompt-diagram', 'diagram'),
    },
  };
  try {
    await api('POST', '/api/config', cfg);
    // Reload question list and marking models
    const qs = await api('GET', '/api/config/questions');
    state.questions = qs;
    state.markingModels = cfg.marking_models || [];
    populateJobSelects();
    renderMarkingModelCheckboxes(state.markingModels);
    closeConfig();
    if (state.currentView === 'matrix') loadMatrix();
  } catch (e) {
    alert('Error saving config: ' + e.message);
  }
}

async function loadLogs() {
  const box = document.getElementById('log-box');
  if (!box) return;
  try {
    const data = await api('GET', '/api/logs?lines=200');
    box.textContent = data.lines.length ? data.lines.join('\n') : 'No log entries.';
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.textContent = 'Error loading logs: ' + e.message;
  }
}

async function checkAws() {
  const el = document.getElementById('aws-check-result');
  el.textContent = 'Checking…';
  try {
    const r = await api('POST', '/api/config/aws_check');
    el.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
    el.style.color = r.ok ? '#51cf66' : '#ff6b6b';
  } catch (e) {
    el.textContent = 'Error: ' + e.message;
    el.style.color = '#ff6b6b';
  }
}

function closeConfig() {
  document.getElementById('config-modal').classList.remove('open');
}

// Close modal on background click
document.getElementById('config-modal').addEventListener('click', function(e) {
  if (e.target === this) closeConfig();
});

// ── Student identity edit ─────────────────────────────────────────────────────

let _editStudentKey = null;

function openStudentEdit(studentKey) {
  const s = state.matrix?.students.find(s => s.student_key === studentKey);
  if (!s) return;
  _editStudentKey = studentKey;

  document.getElementById('se-name').value = s.Name || '';
  document.getElementById('se-student-id').value = s.StudentID || '';
  document.getElementById('se-candidate-number').value = s.CandidateNumber || '';
  document.getElementById('se-status').textContent = '';

  const imgEl = document.getElementById('se-header-img');
  const questions = Object.keys(s.question_files || {});
  const firstFiles = questions.length ? (s.question_files[questions[0]] || []) : [];
  if (firstFiles.length) {
    const q = questions[0];
    const fid = firstFiles[0].file_id;
    imgEl.innerHTML = `<img src="/pdf/header/${q}/${encodeURIComponent(fid)}/image"
      style="max-width:100%;max-height:400px;border-radius:6px;border:1px solid #2a2a3e"
      onerror="this.outerHTML='<div class=empty style=padding:24px>Header image not available</div>'">`;
  } else {
    imgEl.innerHTML = '<div class="muted" style="padding:12px;text-align:center">No header scan found</div>';
  }

  document.getElementById('student-edit-modal').classList.add('open');
}

function closeStudentEdit() {
  document.getElementById('student-edit-modal').classList.remove('open');
  _editStudentKey = null;
}

async function saveStudentIdentity() {
  if (!_editStudentKey) return;
  const payload = {
    Name: document.getElementById('se-name').value.trim(),
    StudentID: document.getElementById('se-student-id').value.trim(),
    CandidateNumber: document.getElementById('se-candidate-number').value.trim(),
  };
  const st = document.getElementById('se-status');
  st.textContent = 'Saving…';
  st.style.color = '#888';
  try {
    const r = await api('POST', `/api/scan/student/${encodeURIComponent(_editStudentKey)}/identity`, payload);
    st.textContent = `✓ Updated ${r.updated} scan record(s)`;
    st.style.color = '#51cf66';
    await loadMatrix();
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
    st.style.color = '#ff6b6b';
  }
}

// Close on background click
document.getElementById('student-edit-modal').addEventListener('click', function(e) {
  if (e.target === this) closeStudentEdit();
});

// ── XSS-safe escape ───────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  }

  try {
    const [qs, cfg] = await Promise.all([
      api('GET', '/api/config/questions'),
      api('GET', '/api/config'),
    ]);
    if (qs.length) state.questions = qs;
    state.markingModels = cfg.marking_models || [];
  } catch (_) {}
  populateJobSelects();
  renderMarkingModelCheckboxes(state.markingModels);
  populateReviewSelects(null, null);
  // Backfill prompt_hash on existing attempts using current config (idempotent)
  api('POST', '/api/migrate/prompt_hashes').catch(() => {});

  // Populate stats filter
  const fq = document.getElementById('filter-question');
  if (fq && state.questions.length) {
    fq.innerHTML = '<option value="">All questions</option>' +
      state.questions.map(q => `<option value="${q}">${q}</option>`).join('');
  }

  loadMatrix();
})();
