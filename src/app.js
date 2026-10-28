import { parseTranscript, isNonSpeech, runChecks } from './checks.js';

const STORE_KEY = 'call-summary-review:v1';
const TYPE_LABEL = { contradiction: 'Contradiction', unsupported: 'Unsupported', omission: 'Omission', rule_breach: 'Rule breach' };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };

const els = {
  queue: document.getElementById('queue-list'),
  review: document.getElementById('review'),
  turns: document.getElementById('turns'),
  progress: document.getElementById('progress'),
};

let calls = [];
let findings = {};
let state = loadState();
let currentId = null;
let activeFinding = null;
let filter = 'all';

// ---------- persistence ----------
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable: keep in memory */ }
}
function callState(id) {
  if (!state[id]) state[id] = { verdict: null, decisions: {}, note: '', corrected: null };
  return state[id];
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sevPill = (sev) => `<span class="pill sev-${sev}">${sev[0].toUpperCase() + sev.slice(1)}</span>`;
const evChips = (ids) => ids.map((t) => `<button class="ev" type="button" data-turn="${t}" title="Show ${t} in transcript">${t}</button>`).join(' ');

function callFindings(id) {
  return [...(findings[id]?.findings || [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}
function counts(id) {
  const c = { high: 0, medium: 0, low: 0 };
  callFindings(id).forEach((f) => c[f.severity]++);
  return c;
}
function direction(call) {
  const first = parseTranscript(call.transcript)[0];
  return /(could|can) I speak to/i.test(first?.text || '') ? 'Outbound' : 'Inbound';
}

// ---------- queue ----------
function renderQueue() {
  const items = calls.filter((c) => {
    const s = state[c.id]?.verdict;
    if (filter === 'attention') return findings[c.id]?.suggestedVerdict === 'needs_correction';
    if (filter === 'unreviewed') return !s;
    if (filter === 'reviewed') return !!s;
    return true;
  });
  els.queue.innerHTML = items.map((c) => {
    const n = counts(c.id);
    const v = state[c.id]?.verdict;
    const acceptable = findings[c.id]?.suggestedVerdict === 'accept';
    const pills = (acceptable ? `<span class="pill sev-ok">${n.high + n.medium + n.low ? 'Acceptable' : 'No issues found'}</span>` : '')
      + ['high', 'medium', 'low'].filter((k) => n[k]).map((k) => `<span class="pill sev-${k}">${n[k]} ${k}</span>`).join('');
    const status = v === 'accept' ? '<span class="status-dot accept">✓ Accepted</span>'
      : v === 'needs_correction' ? '<span class="status-dot needs_correction">✎ Correct</span>'
      : '<span class="status-dot none">Unreviewed</span>';
    return `<li><div class="queue-item${c.id === currentId ? ' selected' : ''}" role="button" tabindex="0" data-id="${c.id}">
      <span class="qid">${c.id}</span>${status}
      <span class="qmeta">${direction(c)} · ${c.estimated_duration}</span>
      <span class="qmeta">${pills}</span></div></li>`;
  }).join('') || '<li class="empty">No calls match this filter.</li>';
  const done = calls.filter((c) => state[c.id]?.verdict).length;
  els.progress.textContent = `${done} / ${calls.length} reviewed`;
}

// ---------- summary highlighting ----------
function highlightSummary(summary, list) {
  const ranges = [];
  for (const f of list) {
    if (!f.quote) continue;
    const i = summary.indexOf(f.quote);
    if (i < 0) continue;
    if (ranges.some((r) => i < r.end && i + f.quote.length > r.start)) continue;
    ranges.push({ start: i, end: i + f.quote.length, f });
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    out += esc(summary.slice(pos, r.start));
    out += `<mark class="flag sev-${r.f.severity}${activeFinding === r.f.id ? ' active' : ''}" data-fid="${r.f.id}" title="${esc(TYPE_LABEL[r.f.type])}">${esc(summary.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  return out + esc(summary.slice(pos));
}

// ---------- review panel ----------
function renderReview() {
  const call = calls.find((c) => c.id === currentId);
  if (!call) { els.review.innerHTML = '<p class="muted">Select a call.</p>'; return; }
  const meta = findings[call.id] || { findings: [] };
  const cs = callState(call.id);
  const list = callFindings(call.id);
  const auto = runChecks(call.transcript, call.summary);
  const suggested = meta.suggestedVerdict === 'accept'
    ? '<span class="pill sev-ok">Suggested: accept</span>'
    : `<span class="pill sev-high">Suggested: needs correction</span>`;
  const corrected = cs.corrected ?? meta.correctedSummary ?? call.summary;

  els.review.innerHTML = `
    <div class="call-head">
      <div><h3>${call.id}</h3><span class="meta">${direction(call)} · ${call.call_date} · ${call.estimated_duration}</span></div>
      <div class="verdict-hint">${suggested}</div>
    </div>

    <div>
      <div class="section-head"><h2>Summary under review</h2><span class="muted small">Highlighted text has a finding. Click it to see the details.</span></div>
      <div class="summary-box" id="summary-box">${highlightSummary(call.summary, list)}</div>
    </div>

    <div>
      <div class="section-head"><h2>Findings <span class="pill src-analyst">Analyst</span></h2><span class="muted small">${list.length} finding${list.length === 1 ? '' : 's'}</span></div>
      <div class="cards">
        ${meta.suggestedVerdict === 'accept' ? `<div class="empty">No meaningful errors found. The summary is consistent with the transcript and the rules.${list.length ? ' The notes below are minor and do not change the meaning.' : ''}</div>` : ''}
        ${list.map((f) => findingCard(f, cs)).join('')}
        ${meta.verifiedNotes ? `<div class="verified"><strong>What was verified:</strong> ${esc(meta.verifiedNotes)}</div>` : ''}
      </div>
    </div>

    <div>
      <div class="section-head"><h2>Rule checks <span class="pill src-auto">Automated</span></h2><span class="muted small">Deterministic; may miss or over-flag</span></div>
      ${autoList(auto)}
    </div>

    <div class="decide">
      <h2>Your decision</h2>
      <div class="verdict-btns">
        <button class="vbtn accept${cs.verdict === 'accept' ? ' on' : ''}" data-verdict="accept" type="button">✓ Accept summary</button>
        <button class="vbtn needs_correction${cs.verdict === 'needs_correction' ? ' on' : ''}" data-verdict="needs_correction" type="button">✎ Needs correction</button>
      </div>
      <label class="field">Corrected summary ${meta.correctedSummary ? '<span class="muted small">(prefilled with the suggested correction; edit as needed)</span>' : ''}
        <textarea id="corrected" rows="6">${esc(corrected)}</textarea>
      </label>
      <div class="row">
        ${meta.correctedSummary ? '<button class="btn" id="reset-suggested" type="button">Reset to suggested</button>' : ''}
        <button class="btn" id="reset-original" type="button">Reset to original</button>
      </div>
      <div id="corrected-checks"></div>
      <label class="field">Reviewer note
        <textarea id="note" rows="2" placeholder="Optional: rationale, escalation, or feedback for the summary pipeline">${esc(cs.note)}</textarea>
      </label>
    </div>`;
  renderCorrectedChecks(call, corrected);
}

function findingCard(f, cs) {
  const d = cs.decisions[f.id];
  return `<div class="card sev-${f.severity}-b${activeFinding === f.id ? ' active' : ''}${d === 'disagree' ? ' dismissed' : ''}" data-fid="${f.id}">
    <div class="card-top">
      ${sevPill(f.severity)}
      <span class="pill type">${TYPE_LABEL[f.type]}</span>
      <span class="pill cert">${f.certainty === 'definite' ? 'Definite' : 'Uncertain: judgement call'}</span>
    </div>
    ${f.quote ? `<div class="quote">“${esc(f.quote)}”</div>` : '<div class="quote">Missing from summary</div>'}
    <p>${esc(f.explanation)}</p>
    <div class="fix"><b>Fix:</b> ${esc(f.fix)}</div>
    <div class="card-actions">
      <span class="muted small">Evidence:</span> ${evChips(f.evidence)}
      <span style="flex:1"></span>
      <button class="decision agree${d === 'agree' ? ' on' : ''}" data-decide="agree" data-fid="${f.id}" type="button">Agree</button>
      <button class="decision disagree${d === 'disagree' ? ' on' : ''}" data-decide="disagree" data-fid="${f.id}" type="button">Disagree</button>
    </div>
  </div>`;
}

function autoList(results) {
  if (!results.length) return '<div class="empty">All automated rule checks passed.</div>';
  return `<ul class="auto-list">${results.map((r) => `<li>${sevPill(r.severity)} <strong>${esc(r.rule)}</strong> <span>${esc(r.message)}</span> ${r.quote ? `<span class="muted">“${esc(r.quote)}”</span>` : ''} ${evChips(r.evidence)}</li>`).join('')}</ul>`;
}

function renderCorrectedChecks(call, text) {
  const box = document.getElementById('corrected-checks');
  if (!box) return;
  const results = runChecks(call.transcript, text);
  box.innerHTML = `<div class="section-head"><h2>Rule checks on corrected text <span class="pill src-auto">Automated</span></h2></div>${autoList(results)}`;
}

// ---------- transcript ----------
function renderTranscript() {
  const call = calls.find((c) => c.id === currentId);
  if (!call) { els.turns.innerHTML = ''; return; }
  const hl = new Set();
  const f = callFindings(call.id).find((x) => x.id === activeFinding);
  if (f) f.evidence.forEach((t) => hl.add(t));
  els.turns.innerHTML = parseTranscript(call.transcript).map((t) => {
    const non = isNonSpeech(t);
    const isHallucination = /unclear speaker/i.test(t.speaker);
    const spkClass = /^agent/i.test(t.speaker) ? 'agent' : '';
    return `<li class="turn${non ? ' nonspeech' : ''}${hl.has(t.id) ? ' hl' : ''}" id="turn-${t.id}">
      <span class="tid">${t.id}</span>
      <span><span class="time">${t.time}</span><span class="spk ${spkClass}">${esc(t.speaker)}:</span>${esc(t.text)}
      ${isHallucination ? ' <span class="pill sev-low tag">Likely ASR hallucination during hold: ignore</span>' : ''}</span>
    </li>`;
  }).join('');
}

function showTurn(id) {
  const el = document.getElementById(`turn-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- selection ----------
function selectCall(id) {
  currentId = id;
  activeFinding = null;
  try { history.replaceState(null, '', `#${id}`); } catch { /* ignore */ }
  renderQueue();
  renderReview();
  renderTranscript();
  document.getElementById('turns').parentElement.scrollTop = 0;
}

function selectFinding(fid) {
  activeFinding = activeFinding === fid ? null : fid;
  renderReview();
  renderTranscript();
  const f = callFindings(currentId).find((x) => x.id === activeFinding);
  if (f && f.evidence[0]) showTurn(f.evidence[0]);
}

function step(delta) {
  const visible = [...els.queue.querySelectorAll('.queue-item')].map((e) => e.dataset.id);
  const list = visible.length ? visible : calls.map((c) => c.id);
  const i = list.indexOf(currentId);
  const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
  if (next) selectCall(next);
}

function setVerdict(v) {
  const cs = callState(currentId);
  cs.verdict = cs.verdict === v ? null : v;
  cs.reviewedAt = new Date().toISOString();
  saveState();
  renderQueue();
  renderReview();
}

// ---------- export ----------
function exportRows() {
  return calls.map((c) => {
    const cs = state[c.id] || {};
    const list = callFindings(c.id);
    const meta = findings[c.id] || {};
    const corrected = cs.corrected ?? meta.correctedSummary ?? null;
    return {
      id: c.id,
      verdict: cs.verdict || 'unreviewed',
      suggested_verdict: meta.suggestedVerdict,
      high: list.filter((f) => f.severity === 'high').length,
      medium: list.filter((f) => f.severity === 'medium').length,
      low: list.filter((f) => f.severity === 'low').length,
      agreed_findings: list.filter((f) => cs.decisions?.[f.id] === 'agree').map((f) => f.id),
      disagreed_findings: list.filter((f) => cs.decisions?.[f.id] === 'disagree').map((f) => f.id),
      reviewer_note: cs.note || '',
      corrected_summary: cs.verdict === 'needs_correction' ? corrected : '',
      reviewed_at: cs.reviewedAt || '',
    };
  });
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toCsv(rows) {
  const cols = Object.keys(rows[0]);
  const cell = (v) => `"${String(Array.isArray(v) ? v.join(' ') : v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

// ---------- events ----------
els.queue.addEventListener('click', (e) => {
  const item = e.target.closest('.queue-item');
  if (item) selectCall(item.dataset.id);
});
els.queue.addEventListener('keydown', (e) => {
  const item = e.target.closest('.queue-item');
  if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectCall(item.dataset.id); }
});

document.querySelector('.filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderQueue();
});

els.review.addEventListener('click', (e) => {
  const ev = e.target.closest('.ev');
  if (ev) { showTurn(ev.dataset.turn); return; }
  const dec = e.target.closest('[data-decide]');
  if (dec) {
    const cs = callState(currentId);
    cs.decisions[dec.dataset.fid] = cs.decisions[dec.dataset.fid] === dec.dataset.decide ? undefined : dec.dataset.decide;
    saveState();
    renderReview();
    return;
  }
  const vb = e.target.closest('[data-verdict]');
  if (vb) { setVerdict(vb.dataset.verdict); return; }
  if (e.target.id === 'reset-suggested' || e.target.id === 'reset-original') {
    const cs = callState(currentId);
    const call = calls.find((c) => c.id === currentId);
    cs.corrected = e.target.id === 'reset-original' ? call.summary : findings[currentId].correctedSummary;
    saveState();
    renderReview();
    return;
  }
  const mark = e.target.closest('mark.flag, .card');
  if (mark && !e.target.closest('button, textarea')) selectFinding(mark.dataset.fid);
});

els.review.addEventListener('input', (e) => {
  const cs = callState(currentId);
  if (e.target.id === 'corrected') {
    cs.corrected = e.target.value;
    renderCorrectedChecks(calls.find((c) => c.id === currentId), e.target.value);
  }
  if (e.target.id === 'note') cs.note = e.target.value;
  saveState();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'j') step(1);
  if (e.key === 'k') step(-1);
  if (e.key === 'a') setVerdict('accept');
  if (e.key === 'c') setVerdict('needs_correction');
});

document.getElementById('help-btn').addEventListener('click', () => {
  const h = document.getElementById('help');
  h.hidden = !h.hidden;
});
document.getElementById('export-json').addEventListener('click', () =>
  download('summary-review-decisions.json', JSON.stringify(exportRows(), null, 2), 'application/json'));
document.getElementById('export-csv').addEventListener('click', () =>
  download('summary-review-decisions.csv', toCsv(exportRows()), 'text/csv'));

// ---------- boot ----------
async function boot() {
  try {
    const [c, f] = await Promise.all([
      fetch('data/candidate-calls.json').then((r) => r.json()),
      fetch('data/findings.json').then((r) => r.json()),
    ]);
    calls = c.sort((a, b) => a.id.localeCompare(b.id));
    findings = f.calls;
    const fromHash = location.hash.slice(1);
    selectCall(calls.some((x) => x.id === fromHash) ? fromHash : calls[0].id);
  } catch (err) {
    els.review.innerHTML = `<p>Could not load data (${esc(err.message)}). Serve this folder over HTTP rather than opening the file directly.</p>`;
  }
}
boot();
