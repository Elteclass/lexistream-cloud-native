'use strict';

/*CONSTANTS*/
const BACKEND_URL = 'http://localhost:8000';
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

/*
LOCAL QUEUE STATE
Each entry: { id, file, status }
status: 'pending' | 'uploading' | 'success' | 'error'
*/
let queue = [];
let idCounter = 0;

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

    // 4. Success
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
document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach(t => {
      t.classList.remove('main-tab--active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('main-tab--active');
    tab.setAttribute('aria-selected', 'true');
  });
});

/*INITIAL RENDER*/
renderQueue();

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
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!topWords || topWords.length === 0) return;

  const paddingX = 40;
  const paddingY = 30;
  const chartWidth = canvas.width - (paddingX * 2);
  const chartHeight = canvas.height - (paddingY * 2);
  const barWidth = chartWidth / topWords.length;
  const maxFreq = topWords[0][1]; 

  ctx.font = '12px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';

  topWords.forEach((item, index) => {
      const word = item[0];
      const freq = item[1];
      const barHeight = (freq / maxFreq) * chartHeight;
      
      const x = paddingX + (index * barWidth);
      const y = canvas.height - paddingY - barHeight;

      // Dibujar barra (Color Primary #3B82F6)
      ctx.fillStyle = '#3B82F6';
      ctx.fillRect(x + 10, y, barWidth - 20, barHeight);

      // Texto de la palabra debajo
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(word, x + (barWidth / 2), canvas.height - 10);
      
      // Número encima de la barra
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(freq.toString(), x + (barWidth / 2), y - 5);
  });
}