/* app.js — Marking Overseer SPA */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
  currentView: 'matrix',
  matrix: null,        // {students: [], questions: []}
  reviewStudent: null, // student_key string
  reviewQuestion: null,
  reviewData: null,    // api response
  config: null,
  questions: window.INIT ? window.INIT.questions : [],
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
  if (name === 'jobs') populateJobSelects();
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
      <div style="font-weight:600;font-size:13px">${esc(s.display_name)}</div>
      <div class="muted">${s.StudentID || s.CandidateNumber || ''}</div>
    </td>`;

    for (const q of questions) {
      const status = s.question_status[q] || 'not_attempted';
      const files = (s.question_files[q] || []);
      const conflicts = files.some(f => f.human_mark_conflict);
      html += `<td style="text-align:center">
        <button class="matrix-cell-btn" onclick="openReview('${esc(s.student_key)}','${q}')">
          ${chip(status)}
          ${conflicts ? '<span class="tag-conflict" title="Human mark conflict">⚠</span>' : ''}
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
  state.reviewStudent = studentKey;
  state.reviewQuestion = question;
  showView('review');
  populateReviewSelects(studentKey, question);
  loadReview(studentKey, question);
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

  // Images
  html += `<div class="review-grid" style="margin-bottom:14px">
    <div>
      <div class="muted" style="margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Student Work</div>
      <img class="pdf-img" src="${fr.body_image_url}" alt="Student work"
           onerror="this.style.display='none';this.nextSibling.style.display='block'">
      <div style="display:none" class="empty">Body PDF not found</div>
    </div>
    <div>
      <div class="muted" style="margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Answer Sheet</div>
      ${fr.answer_image_url
        ? `<img class="pdf-img" src="${fr.answer_image_url}" alt="Answer sheet"
               onerror="this.style.display='none';this.nextSibling.style.display='block'">
           <div style="display:none" class="empty">Answer PDF not found for this QID</div>`
        : '<div class="empty">No QID extracted yet</div>'
      }
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
  let html = `<div class="attempt-row" style="border-color:${borderColor};${rejected ? 'opacity:.5' : ''}">
    <div class="attempt-header">
      ${a.result ? chip(a.result) : '<span class="muted">—</span>'}
      <span class="attempt-label">${esc(a.model_label || a.model)}</span>
      <span class="badge">${esc(a.ai_approach)}</span>
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
    html += `<div class="muted text-sm" style="margin-top:8px">Extracted answer (step 1):</div>
      <div class="step1-box">${esc(a.step1_result)}</div>`;
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
  const body = q ? { questions: [q] } : {};

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
  if (!approaches.length) { alert('Select at least one approach.'); return; }

  const q = document.getElementById('j4-questions').value;
  const skip = document.getElementById('j4-skip').checked;
  const body = { approaches, skip_existing: skip };
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

async function loadStats() {
  const el = document.getElementById('stats-summary');
  try {
    const stats = await api('GET', '/api/stats/attempts');
    if (!stats.length) {
      el.innerHTML = '<div class="empty">No attempts yet.</div>';
      return;
    }
    let html = '<table class="stats-table"><thead><tr>';
    html += '<th>Model / Approach</th><th>Count</th><th>Pass</th><th>Fail</th><th>Error</th>';
    html += '<th>Pass rate</th><th>Avg latency</th><th>Avg cost</th><th>Total cost</th>';
    html += '</tr></thead><tbody>';
    for (const g of stats) {
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
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
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
    if (!attempts.length) {
      el.innerHTML = '<div class="empty">No attempts match filter.</div>';
      return;
    }
    let html = '<table class="stats-table"><thead><tr>';
    html += '<th>Time</th><th>File</th><th>QID</th><th>Q</th><th>Approach</th><th>Model</th>';
    html += '<th>Result</th><th>Latency</th><th>Cost</th><th>Rejected</th>';
    html += '</tr></thead><tbody>';
    for (const a of [...attempts].reverse()) {
      const ts = a.timestamp ? a.timestamp.slice(0, 19).replace('T', ' ') : '—';
      html += `<tr>
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
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
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
    document.getElementById('cfg-prompt-answer-sheet-extract').value = p.answer_sheet_extract || defs.answer_sheet_extract || '';
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

function _promptVal(id, defaultKey) {
  const v = document.getElementById(id).value.trim();
  const def = (state.promptDefaults || {})[defaultKey] || '';
  return v === def ? '' : v;
}

async function saveConfig() {
  const cfg = {
    data_root: document.getElementById('cfg-data-root').value.trim(),
    answer_sheets_root: document.getElementById('cfg-answer-sheets-root').value.trim(),
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
      answer_sheet_extract: _promptVal('cfg-prompt-answer-sheet-extract', 'answer_sheet_extract'),
    },
  };
  try {
    await api('POST', '/api/config', cfg);
    // Reload question list
    const qs = await api('GET', '/api/config/questions');
    state.questions = qs;
    populateJobSelects();
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

// ── XSS-safe escape ───────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  try {
    const qs = await api('GET', '/api/config/questions');
    if (qs.length) state.questions = qs;
  } catch (_) {}
  populateJobSelects();
  populateReviewSelects(null, null);

  // Populate stats filter
  const fq = document.getElementById('filter-question');
  if (fq && state.questions.length) {
    fq.innerHTML = '<option value="">All questions</option>' +
      state.questions.map(q => `<option value="${q}">${q}</option>`).join('');
  }

  loadMatrix();
})();
