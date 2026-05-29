"use strict";

/*CONSTANTS*/
// Resolve backend URL in this order:
// 1. <meta name="backend-url" content="..."> if present in HTML
// 2. If served from localhost, assume backend at port 8000
// 3. Otherwise, use same origin (window.location.origin)
const BACKEND_URL = (function() {
  try {
    const meta = document.querySelector('meta[name="backend-url"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
  } catch (e) {}

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return `${window.location.protocol}//${host}:8000`;
  }

  return window.location.origin;
})();
const ALLOWED_TYPES = ['.txt', '.pdf'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/*DOM REFERENCES*/
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const localQueueEl = document.getElementById('local-queue');
const queueCountEl = document.getElementById('queue-count');
const btnStart = document.getElementById('btn-start');
const uploadErrorEl = document.getElementById('upload-error');
const uploadErrorMsg = document.getElementById('upload-error-msg');
const uploadToast = document.getElementById('upload-toast');
const uploadToastMsg = document.getElementById('upload-toast-msg');
const queueEmptyMsg = document.getElementById('queue-empty-msg');
const processedListEl = document.getElementById('processed-list');
const processedCountEl = document.getElementById('processed-count');
const processedEmptyMsg = document.getElementById('processed-empty-msg');
const analyzerPanel = document.getElementById('analyzer-panel');
const dashboardPanel = document.getElementById('dashboard-panel');
const workerGridEl = document.getElementById('worker-grid');
const systemLogGroupsEl = document.getElementById('system-log-groups');
const dashboardConnectionStatusEl = document.getElementById('dashboard-connection-status');
const dashboardTotalCountEl = document.getElementById('dashboard-total-count');
const dashboardIdleCountEl = document.getElementById('dashboard-idle-count');
const dashboardProcessingCountEl = document.getElementById('dashboard-processing-count');
const dashboardDownCountEl = document.getElementById('dashboard-down-count');

/*
LOCAL QUEUE STATE
Each entry: { id, file, status }
status: 'pending' | 'uploading' | 'success' | 'error'
*/
let queue = [];
let idCounter = 0;
const processedTasks = new Map();
let telemetrySource = null;
let dashboardWorkers = [];
const logsByWorker = {};
const MAX_LOG_LINES_PER_WORKER = 70;
let telemetryMode = 'mock';
const tabs = Array.from(document.querySelectorAll('.main-tab'));
const tabPanels = {
  'tab-analyzer': analyzerPanel,
  'tab-dashboard': dashboardPanel,
};

const dashboardFallback = {
  workers: [
    { worker_id: 'wk-nx-01', state: 'IDLE', uptime: 13445, tasks_done: 42 },
    { worker_id: 'wk-nx-02', state: 'PROCESSING', uptime: 13304, tasks_done: 104 },
    { worker_id: 'wk-nx-03', state: 'IDLE', uptime: 7750, tasks_done: 12 },
  ],
  logs: {
    'wk-nx-01': [
      { timestamp: 1716902400, state: 'INFO', message: 'Node joined telemetry channel.' },
      { timestamp: 1716902460, state: 'INFO', message: 'Awaiting new batch assignments.' },
    ],
    'wk-nx-02': [
      { timestamp: 1716902520, state: 'INFO', message: 'Worker-2 connected to task queue.' },
      { timestamp: 1716902580, state: 'DEBUG', message: 'Processing 1500 documents.' },
    ],
    'wk-nx-03': [
      { timestamp: 1716902100, state: 'INFO', message: 'Health heartbeat received.' },
    ],
  },
};

/*UTILITIES*/
/** Format bytes to human-readable string */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Extract lowercase extension from filename */
function getExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

/** Show an error message under the drop zone */
function showUploadError(msg) {
  uploadErrorMsg.textContent = msg;
  uploadErrorEl.hidden = false;
  // Auto-hide after 5 s
  clearTimeout(showUploadError._timer);
  showUploadError._timer = setTimeout(() => { uploadErrorEl.hidden = true; }, 5000);
}

/** Show / hide the global progress toast */
function showToast(msg) {
  uploadToastMsg.textContent = msg;
  uploadToast.hidden = false;
}
function hideToast() {
  uploadToast.hidden = true;
}

function formatTimestamp(timestamp) {
  const date = new Date((timestamp || Date.now() / 1000) * 1000);
  return date.toLocaleTimeString([], { hour12: false });
}

function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hh = String(Math.floor(safe / 3600)).padStart(2, '0');
  const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(safe % 60)).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function getWorkerStateClass(state) {
  if (state === 'PROCESSING') return 'worker-card--processing';
  if (state === 'DOWN') return 'worker-card--down';
  return 'worker-card--idle';
}

function getDisplayWorkerName(workerId) {
  const normalized = String(workerId || '').toLowerCase().replace(/_/g, '-');
  const match = normalized.match(/(\d+)/);
  if (match) return `Worker-${match[1]}`;
  return String(workerId || 'Worker-?');
}

function getDisplayNodeId(workerId) {
  const normalized = String(workerId || '').toLowerCase().replace(/_/g, '-');
  const match = normalized.match(/(\d+)/);
  if (match) return `wk-nx-0${match[1]}`;
  return 'wk-nx-00';
}

function getRelativeAge(timestamp) {
  if (!timestamp) return 'no entries yet';
  const delta = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

function buildLogEntrySignature(entry) {
  const timestamp = Number(entry?.timestamp) || 0;
  const state = String(entry?.state || 'INFO');
  const message = String(entry?.message || entry?.state || 'event received');
  return `${timestamp}|${state}|${message}`;
}

function appendWorkerLogEntry(workerId, entry) {
  if (!logsByWorker[workerId]) logsByWorker[workerId] = [];
  const lines = logsByWorker[workerId];

  // SSE reconnects can replay the latest event; ignore exact back-to-back duplicates.
  if (lines.length > 0) {
    const lastEntry = lines[lines.length - 1];
    if (buildLogEntrySignature(lastEntry) === buildLogEntrySignature(entry)) {
      return false;
    }
  }

  lines.push(entry);

  if (lines.length > MAX_LOG_LINES_PER_WORKER) {
    logsByWorker[workerId] = lines.slice(-MAX_LOG_LINES_PER_WORKER);
  }

  return true;
}

function renderLogGroups() {
  if (!systemLogGroupsEl) return;

  const previouslyOpenWorker = systemLogGroupsEl.querySelector('details[open]')?.dataset.workerId || null;
  const workerIds = Object.keys(logsByWorker).sort((a, b) => a.localeCompare(b));
  systemLogGroupsEl.innerHTML = '';

  if (workerIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'system-log-group system-log-group--empty';
    empty.textContent = 'Waiting for worker logs...';
    systemLogGroupsEl.appendChild(empty);
    return;
  }

  workerIds.forEach((workerId, index) => {
    const lines = logsByWorker[workerId] || [];
    const details = document.createElement('details');
    details.className = 'system-log-group';
    details.dataset.workerId = workerId;
    details.open = previouslyOpenWorker ? previouslyOpenWorker === workerId : index === 0;

    details.addEventListener('toggle', () => {
      if (details.open) {
        telemetryMode = 'live';
      }
    });

    const summary = document.createElement('summary');
    summary.className = 'system-log-group__summary';
    const latest = lines.length ? lines[lines.length - 1] : null;
    const liveHint = latest && (Date.now() / 1000 - (latest.timestamp || 0)) < 20 ? 'Streaming' : 'Idle';
    summary.innerHTML = `
      <span class="system-log-group__worker">${getDisplayWorkerName(workerId)} Logs</span>
      <span class="system-log-group__meta">${liveHint} · Last entry: ${getRelativeAge(lines.length ? lines[lines.length - 1].timestamp : 0)}</span>
    `;

    const terminal = document.createElement('div');
    terminal.className = 'system-terminal';

    const output = document.createElement('div');
    output.className = 'system-terminal__output';
    lines.forEach((entry) => {
      const line = document.createElement('div');
      line.className = 'system-terminal__line';
      const message = entry.message || entry.state || 'event received';
      line.textContent = `[${formatTimestamp(entry.timestamp)}] [${entry.state || 'INFO'}] ${message}`;
      output.appendChild(line);
    });

    terminal.appendChild(output);
    details.appendChild(summary);
    details.appendChild(terminal);
    systemLogGroupsEl.appendChild(details);
  });
}

function renderWorkerCards(workers) {
  if (!workerGridEl) return;

  workerGridEl.innerHTML = '';

  if (!workers.length) {
    const emptyCard = document.createElement('article');
    emptyCard.className = 'worker-card worker-card--empty';
    emptyCard.innerHTML = '<p>No workers are reporting yet.</p>';
    workerGridEl.appendChild(emptyCard);
    return;
  }

  workers.forEach((worker) => {
    const card = document.createElement('article');
    const stateClass = getWorkerStateClass(worker.state);
    card.className = `worker-card ${stateClass}`;
    card.innerHTML = `
      <div class="worker-card__header">
        <div>
          <p class="worker-card__label">${getDisplayWorkerName(worker.worker_id)}</p>
          <h3 class="worker-card__id">ID: ${getDisplayNodeId(worker.worker_id)}</h3>
        </div>
        <span class="worker-status ${stateClass.replace('worker-card', 'worker-status')}">${worker.state}</span>
      </div>
      <dl class="worker-card__metrics">
        <div>
          <dt>Uptime</dt>
          <dd>${formatDuration(worker.uptime)}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>${worker.tasks_done} tasks completed</dd>
        </div>
      </dl>
    `;
    workerGridEl.appendChild(card);
  });
}

function renderDashboardSummary(workers) {
  const total = workers.length;
  const idle = workers.filter((worker) => worker.state === 'IDLE').length;
  const processing = workers.filter((worker) => worker.state === 'PROCESSING').length;
  const down = workers.filter((worker) => worker.state === 'DOWN').length;

  dashboardTotalCountEl.textContent = String(total);
  dashboardIdleCountEl.textContent = String(idle);
  dashboardProcessingCountEl.textContent = String(processing);
  dashboardDownCountEl.textContent = String(down);
}

function renderTelemetrySnapshot(payload) {
  const workers = Array.isArray(payload.workers) ? payload.workers : [];
  dashboardWorkers = workers;
  renderDashboardSummary(workers);
  renderWorkerCards(workers);

  if (telemetryMode === 'live') {
    const liveWorkerIds = new Set(workers.map((worker) => worker.worker_id));

    Object.keys(logsByWorker).forEach((workerId) => {
      if (workerId.startsWith('wk-nx-') || !liveWorkerIds.has(workerId)) {
        delete logsByWorker[workerId];
      }
    });

    workers.forEach((worker) => {
      if (!logsByWorker[worker.worker_id]) {
        logsByWorker[worker.worker_id] = [];
      }
    });
  }
}

function seedDashboardFallback() {
  if (dashboardWorkers.length > 0) return;
  telemetryMode = 'mock';
  renderTelemetrySnapshot(dashboardFallback);
  Object.entries(dashboardFallback.logs).forEach(([workerId, entries]) => {
    logsByWorker[workerId] = entries.slice();
  });
  renderLogGroups();
}

async function loadTelemetrySnapshot() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/system-telemetry/snapshot`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      seedDashboardFallback();
      return;
    }

    const payload = await response.json();
    telemetryMode = 'live';
    renderTelemetrySnapshot(payload);
    renderLogGroups();
  } catch (error) {
    console.warn('[LexiStream] Unable to load telemetry snapshot:', error);
    seedDashboardFallback();
  }
}

function openTelemetryStream() {
  if (telemetrySource) return;

  try {
    telemetrySource = new EventSource(`${BACKEND_URL}/api/system-telemetry`);
    dashboardConnectionStatusEl.textContent = 'SYS.CONN: LINKING';
    renderLogGroups();

    telemetrySource.addEventListener('open', () => {
      dashboardConnectionStatusEl.textContent = 'SYS.CONN: STABLE';
    });

    telemetrySource.addEventListener('telemetry', (event) => {
      renderTelemetrySnapshot(JSON.parse(event.data));
    });

    telemetrySource.addEventListener('log', (event) => {
      const entry = JSON.parse(event.data);
      const workerId = entry.worker_id || 'system';
      const wasAppended = appendWorkerLogEntry(workerId, entry);
      if (wasAppended) {
        renderLogGroups();
      }
    });

    telemetrySource.onerror = () => {
      dashboardConnectionStatusEl.textContent = 'SYS.CONN: RETRY';
    };
  } catch (error) {
    console.warn('[LexiStream] Telemetry stream unavailable:', error);
    seedDashboardFallback();
  }
}

function closeTelemetryStream() {
  if (telemetrySource) {
    telemetrySource.close();
    telemetrySource = null;
  }

  if (dashboardConnectionStatusEl) {
    dashboardConnectionStatusEl.textContent = 'SYS.CONN: DISCONNECTED';
  }
}

function activateTab(tabId) {
  tabs.forEach(tab => {
    const isActive = tab.id === tabId;
    tab.classList.toggle('main-tab--active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(tabPanels).forEach(([panelId, panel]) => {
    if (!panel) return;
    panel.hidden = panelId !== tabId;
  });

  if (tabId === 'tab-dashboard') {
    loadTelemetrySnapshot();
    openTelemetryStream();
    if (dashboardWorkers.length > 0) {
      renderWorkerCards(dashboardWorkers);
      renderDashboardSummary(dashboardWorkers);
    } else {
      seedDashboardFallback();
    }
    renderLogGroups();
  } else {
    closeTelemetryStream();
  }
}

function statusToLabel(status) {
  if (status === 'pendiente') return 'Pendiente';
  if (status === 'en proceso') return 'En proceso';
  if (status === 'completada') return 'Completada';
  return 'Error';
}

function statusToClass(status) {
  if (status === 'pendiente') return 'pending';
  if (status === 'en proceso') return 'processing';
  if (status === 'completada') return 'completed';
  return 'error';
}

function renderProcessedEmptyState() {
  processedEmptyMsg.style.display = processedTasks.size === 0 ? 'flex' : 'none';
  processedCountEl.textContent = String(processedTasks.size);
}

function createProcessedCard(taskId, filename) {
  const li = document.createElement('li');
  li.className = 'processed-item pending';
  li.dataset.taskId = taskId;
  li.innerHTML = `
    <div class="processed-item__name" title="${filename}">${filename}</div>
    <div class="processed-item__meta">
      <span class="processed-item__status">Pendiente</span>
      <span class="processed-item__id">${taskId.slice(0, 8)}</span>
    </div>
  `;

  li.addEventListener('click', () => {
    const taskData = processedTasks.get(taskId);
    if (!taskData) return;
    window.renderAnalyticalResults(filename, taskData);
  });

  processedListEl.appendChild(li);
  renderProcessedEmptyState();
}

function updateProcessedCard(taskId, taskData) {
  const card = processedListEl.querySelector(`[data-task-id="${taskId}"]`);
  if (!card) return;

  const statusClass = statusToClass(taskData.status);
  card.classList.remove('pending', 'processing', 'completed', 'error');
  card.classList.add(statusClass);

  const statusEl = card.querySelector('.processed-item__status');
  if (statusEl) {
    statusEl.textContent = statusToLabel(taskData.status);
  }
}

/*CLIENT-SIDE VALIDATION
Returns null if OK, or an error string.*/
function validateFile(file) {
  const ext = getExt(file.name);
  if (!ALLOWED_TYPES.includes(ext)) {
    return `Extension "${ext || 'no extension'}" not allowed. Only .txt and .pdf are allowed.`;
  }
  if (file.size > MAX_SIZE_BYTES) {
    return `"${file.name}" exceeds the 10 MB limit (${formatBytes(file.size)}).`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty (0 bytes).`;
  }
  return null;
}

/*QUEUE RENDERING*/
function renderQueue() {
  // Remove all dynamic items (not the empty-state li)
  localQueueEl.querySelectorAll('.queue-item').forEach(el => el.remove());

  queueEmptyMsg.style.display = queue.length === 0 ? 'flex' : 'none';
  queueCountEl.textContent = queue.length;

  // Enable / disable Start button
  const hasPending = queue.some(q => q.status === 'pending');
  btnStart.disabled = !hasPending;
  btnStart.setAttribute('aria-disabled', String(!hasPending));

  queue.forEach(entry => {
    const ext = getExt(entry.file.name);
    const isPdf = ext === '.pdf';

    // Build file type icon SVG
    const iconSvg = isPdf
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
           <polyline points="14,2 14,8 20,8"/>
           <path d="M9 15h1a1 1 0 0 0 0-2H9v4"/><path d="M13 13h2"/><path d="M13 17h2"/>
         </svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
           <polyline points="14,2 14,8 20,8"/>
           <line x1="16" y1="13" x2="8" y2="13"/>
           <line x1="16" y1="17" x2="8" y2="17"/>
         </svg>`;

    // Status label
    const statusLabels = {
      pending: '',
      uploading: 'Uploading…',
      success: '✓ Uploaded to S3',
      error: '✗ Error uploading',
    };

    const li = document.createElement('li');
    li.className = `queue-item ${entry.status !== 'pending' ? entry.status : ''}`;
    li.dataset.id = entry.id;
    li.setAttribute('role', 'listitem');
    li.setAttribute('aria-label', `${entry.file.name} — ${entry.status}`);
    li.innerHTML = `
      <div class="queue-item__icon" aria-hidden="true">${iconSvg}</div>
      <div class="queue-item__info">
        <div class="queue-item__name" title="${entry.file.name}">${entry.file.name}</div>
        <div class="queue-item__size">${formatBytes(entry.file.size)}</div>
        ${entry.status !== 'pending'
        ? `<div class="queue-item__status">${statusLabels[entry.status]}</div>`
        : ''}
      </div>
      ${entry.status === 'pending'
        ? `<button
             class="queue-item__remove"
             data-id="${entry.id}"
             aria-label="Remove ${entry.file.name} from queue"
             title="Remove from queue"
           >
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>`
        : ''}
      ${entry.status === 'uploading'
        ? `<div class="queue-item__progress"><div class="queue-item__progress-bar"></div></div>`
        : ''}
    `;
    localQueueEl.appendChild(li);
  });

  // Bind remove buttons
  localQueueEl.querySelectorAll('.queue-item__remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      queue = queue.filter(q => q.id !== id);
      renderQueue();
    });
  });
}

/*ADD FILES TO QUEUE*/
function addFiles(files) {
  let errorCount = 0;
  let lastError = '';

  Array.from(files).forEach(file => {
    // Skip duplicates already in queue
    const isDuplicate = queue.some(q => q.file.name === file.name && q.file.size === file.size);
    if (isDuplicate) return;

    const err = validateFile(file);
    if (err) {
      errorCount++;
      lastError = err;
      return;
    }

    queue.push({ id: ++idCounter, file, status: 'pending' });
  });

  if (errorCount > 0) {
    const suffix = errorCount > 1 ? ` (+${errorCount - 1} más)` : '';
    showUploadError(lastError + suffix);
  } else {
    uploadErrorEl.hidden = true;
  }

  renderQueue();
}

/*DRAG & DROP EVENTS*/
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, e => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.body.addEventListener(eventName, e => {
    e.preventDefault();
  });
});

dropZone.addEventListener('dragenter', () => {
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragover', () => {
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', (e) => {
  // Only remove class if leaving the drop zone itself (not a child)
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('dragover');
  }
});

dropZone.addEventListener('drop', (e) => {
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    addFiles(files);
  }
});

/*Click to browse*/
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    addFiles(fileInput.files);
    fileInput.value = ''; // reset so same file can be re-added after removal
  }
});

/*GET PRE-SIGNED URL FROM BACKEND*/
async function getPresignedUrl(file) {
  const params = new URLSearchParams({
    filename: file.name,
    filesize: file.size,
  });

  const response = await fetch(`${BACKEND_URL}/api/presigned-url?${params}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Server error: ${response.status}`);
  }

  const data = await response.json();
  return data.url; // presigned PUT URL
}

/*UPLOAD FILE DIRECTLY TO S3 USING PUT*/
async function uploadToS3(presignedUrl, file) {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`S3 rejected upload: HTTP ${response.status}`);
  }
}

async function enqueueProcessing(filename) {
  const response = await fetch(`${BACKEND_URL}/api/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ filename }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Server error: ${response.status}`);
  }

  return response.json();
}

function openEventStream(taskId, filename) {
  const source = new EventSource(`${BACKEND_URL}/api/stream/${taskId}`);

  source.onmessage = (event) => {
    try {
      const taskData = JSON.parse(event.data);
      processedTasks.set(taskId, taskData);
      updateProcessedCard(taskId, taskData);

      if (taskData.status === 'completada') {
        source.close();
      }
    } catch (err) {
      console.error('[LexiStream] SSE parse error:', err);
    }
  };

  source.onerror = () => {
    const taskData = processedTasks.get(taskId) || { status: 'error', filename };
    taskData.status = 'error';
    processedTasks.set(taskId, taskData);
    updateProcessedCard(taskId, taskData);
    source.close();
  };
}

/*PROCESS A SINGLE QUEUE ENTRY*/
async function processEntry(entry) {
  // 1. Mark as uploading
  entry.status = 'uploading';
  renderQueue();

  try {
    // 2. Request presigned URL from backend
    const presignedUrl = await getPresignedUrl(entry.file);

    // 3. PUT file directly to S3
    await uploadToS3(presignedUrl, entry.file);

    // 4. Enqueue processing task
    const { task_id: taskId } = await enqueueProcessing(entry.file.name);
    processedTasks.set(taskId, { status: 'pendiente', filename: entry.file.name });
    createProcessedCard(taskId, entry.file.name);
    openEventStream(taskId, entry.file.name);

    // 5. Success
    entry.status = 'success';
  } catch (err) {
    console.error(`[LexiStream] Error uploading "${entry.file.name}":`, err);
    entry.status = 'error';
    entry.errorMsg = err.message;
  }

  renderQueue();
}

/*START BUTTON - Process all pending files*/
btnStart.addEventListener('click', async () => {
  const pending = queue.filter(q => q.status === 'pending');
  if (pending.length === 0) return;

  btnStart.disabled = true;
  showToast(`Uploading ${pending.length} file${pending.length > 1 ? 's' : ''}…`);

  // Upload sequentially to avoid flooding S3
  for (const entry of pending) {
    await processEntry(entry);
  }

  hideToast();

  const successes = pending.filter(e => e.status === 'success').length;
  const errors = pending.filter(e => e.status === 'error').length;

  if (errors > 0) {
    showUploadError(
      `${errors} file${errors > 1 ? 's' : ''} could not be uploaded. Check the console.`
    );
  }

  renderQueue();
});

/*TAB SWITCHING*/
tabs.forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.id));
});

/*INITIAL RENDER*/
renderQueue();
renderProcessedEmptyState();
activateTab('tab-analyzer');

/* ═══════════════════════════════════════════════════
   ISSUE #3: MOTOR DE ANÁLISIS Y VISUALIZACIÓN
════════════════════════════════════════════════════ */

// Función global para manejar el cambio de vistas e inyectar datos
window.renderAnalyticalResults = function(filename, taskData) {
  const viewLoading = document.getElementById('view-loading');
  const viewResults = document.getElementById('view-results');
  const filenameText = document.getElementById('filename-text');

  if (filenameText) filenameText.innerText = filename;

  if (taskData.status === "pendiente" || taskData.status === "en proceso") {
      if(viewResults) viewResults.style.display = 'none';
      if(viewLoading) viewLoading.style.display = 'flex';
  } else if (taskData.status === "completada") {
      if(viewLoading) viewLoading.style.display = 'none';
      if(viewResults) viewResults.style.display = 'block';

      const res = taskData.resultados;
      
      // Inyectar texto y números
      document.getElementById('ui-words').innerText = res.word_count.toLocaleString();
      document.getElementById('ui-chars').innerText = res.char_count.toLocaleString();
      document.getElementById('ui-topic').innerText = res.topic;
      document.getElementById('ui-summary').innerText = res.summary;

      // Dibujar la gráfica
      drawNativeBarChart(res.top_words);
  }
};

// Dibujado de barras con Canvas HTML5 Nativo
function drawNativeBarChart(topWords) {
  const canvas = document.getElementById('wordChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth || 220));
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight || 140));
  const dpr = window.devicePixelRatio || 1;

  const targetWidth = Math.round(displayWidth * dpr);
  const targetHeight = Math.round(displayHeight * dpr);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, displayWidth, displayHeight);

  if (!topWords || topWords.length === 0) return;

  const paddingX = 18;
  const paddingTop = 14;
  const paddingBottom = 54;
  const chartWidth = displayWidth - (paddingX * 2);
  const chartHeight = displayHeight - paddingTop - paddingBottom;
  const barWidth = chartWidth / topWords.length;
  const maxFreq = topWords[0][1]; 

  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  function wrapLabel(label, maxLength = 8) {
    const value = String(label || '');
    if (!value) return [''];

    const firstLine = value.slice(0, maxLength);
    const remainder = value.slice(maxLength);

    if (!remainder) return [firstLine];

    const secondLine = remainder.length > maxLength
      ? `${remainder.slice(0, maxLength - 1)}…`
      : remainder;

    return [firstLine, secondLine];
  }

  topWords.forEach((item, index) => {
      const lines = wrapLabel(item[0]);
      const freq = item[1];
      const barHeight = (freq / maxFreq) * chartHeight;
      
      const x = paddingX + (index * barWidth);
      const y = displayHeight - paddingBottom - barHeight;

      // Dibujar barra (Color Primary #3B82F6)
      ctx.fillStyle = '#3B82F6';
      ctx.fillRect(x + 8, y, Math.max(10, barWidth - 16), barHeight);

      // Etiqueta diagonal debajo de la barra.
      const labelX = x + (barWidth / 2) - 4;
      const labelY = displayHeight - 18;
      ctx.save();
      ctx.translate(labelX, labelY);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = '#94A3B8';
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, 0, lineIndex * 10);
      });
      ctx.restore();

      // Número encima de la barra
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(freq.toString(), x + (barWidth / 2), y - 5);
  });
}