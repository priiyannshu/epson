/**
 * Epson L565 Cloud Print - Frontend Controller
 */

// Initialize PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// State
let selectedFile = null;
let currentJobId = null;
let statusPollTimer = null;
let deferredInstallPrompt = null;

const currentSettings = {
  pageSize: 'A4',
  mediaType: 'PLAIN_NORMAL',
  ink: 'MONO',
  copies: 1,
  orientation: 'auto',
  fitToPage: true,
  pageRange: 'All',
};

// DOM Elements
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const browseBtn = document.getElementById('browseBtn');
const previewCard = document.getElementById('previewCard');
const previewFileName = document.getElementById('previewFileName');
const previewFileSize = document.getElementById('previewFileSize');
const fileTypeBadge = document.getElementById('fileTypeBadge');
const changeFileBtn = document.getElementById('changeFileBtn');
const pdfCanvas = document.getElementById('pdfCanvas');
const imagePreview = document.getElementById('imagePreview');
const previewLoading = document.getElementById('previewLoading');
const previewFooter = document.getElementById('previewFooter');
const pdfPageCount = document.getElementById('pdfPageCount');

const printerStatusBadge = document.getElementById('printerStatusBadge');
const printerStatusText = document.getElementById('printerStatusText');
const printerModelLabel = document.getElementById('printerModelLabel');

const inkValBlack = document.getElementById('inkValBlack');
const inkValCyan = document.getElementById('inkValCyan');
const inkValMagenta = document.getElementById('inkValMagenta');
const inkValYellow = document.getElementById('inkValYellow');
const inkBarBlack = document.getElementById('inkBarBlack');
const inkBarCyan = document.getElementById('inkBarCyan');
const inkBarMagenta = document.getElementById('inkBarMagenta');
const inkBarYellow = document.getElementById('inkBarYellow');

const presetButtons = document.querySelectorAll('.preset-btn');
const activePresetBadge = document.getElementById('activePresetBadge');

const accordionToggle = document.getElementById('accordionToggle');
const settingsPanel = document.getElementById('settingsPanel');
const pageSizeSelect = document.getElementById('pageSize');
const mediaTypeSelect = document.getElementById('mediaType');
const inkButtons = document.querySelectorAll('[data-ink]');
const orientButtons = document.querySelectorAll('[data-orient]');
const copiesInput = document.getElementById('copiesInput');
const copyMinus = document.getElementById('copyMinus');
const copyPlus = document.getElementById('copyPlus');
const fitToPageToggle = document.getElementById('fitToPageToggle');
const pageRangeInput = document.getElementById('pageRange');

const printSubmitBtn = document.getElementById('printSubmitBtn');
const printSubmitText = document.getElementById('printSubmitText');

const progressModal = document.getElementById('progressModal');
const trackerJobId = document.getElementById('trackerJobId');
const stepUpload = document.getElementById('stepUpload');
const stepQueued = document.getElementById('stepQueued');
const stepDownloading = document.getElementById('stepDownloading');
const stepPrinting = document.getElementById('stepPrinting');
const statusSpinner = document.getElementById('statusSpinner');
const statusIconDone = document.getElementById('statusIconDone');
const statusIconFailed = document.getElementById('statusIconFailed');
const statusMessageHeading = document.getElementById('statusMessageHeading');
const statusMessageDetail = document.getElementById('statusMessageDetail');
const modalCloseBtn = document.getElementById('modalCloseBtn');

const pwaInstallBanner = document.getElementById('pwaInstallBanner');
const pwaInstallBtn = document.getElementById('pwaInstallBtn');

// 1. Initial Telemetry & Polling Loop
async function updateTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const data = await res.json();

    // Update Status Pill
    printerStatusBadge.className = 'status-badge';
    if (data.state === 'printing') {
      printerStatusBadge.classList.add('status-printing');
      printerStatusText.textContent = 'Printing...';
    } else if (data.isOnline === false || data.state === 'offline') {
      printerStatusBadge.classList.add('status-offline');
      printerStatusText.textContent = 'Offline';
    } else if (data.state === 'disabled') {
      printerStatusBadge.classList.add('status-offline');
      printerStatusText.textContent = 'Queue Paused';
    } else {
      printerStatusBadge.classList.add('status-idle');
      printerStatusText.textContent = 'Ready / Idle';
    }

    if (data.primary_printer) {
      const pName = data.primary_printer.replace(/_/g, ' ');
      printerModelLabel.textContent = `${pName} (Raspberry Pi 5)`;
    }

    // Update Ink Gauges
    if (data.ink) {
      const k = Math.min(100, Math.max(0, data.ink.black ?? 0));
      const c = Math.min(100, Math.max(0, data.ink.cyan ?? 0));
      const m = Math.min(100, Math.max(0, data.ink.magenta ?? 0));
      const y = Math.min(100, Math.max(0, data.ink.yellow ?? 0));

      inkValBlack.textContent = `${k}%`;
      inkBarBlack.style.width = `${k}%`;

      inkValCyan.textContent = `${c}%`;
      inkBarCyan.style.width = `${c}%`;

      inkValMagenta.textContent = `${m}%`;
      inkBarMagenta.style.width = `${m}%`;

      inkValYellow.textContent = `${y}%`;
      inkBarYellow.style.width = `${y}%`;
    }
  } catch (err) {
    console.warn('Telemetry poll failed:', err);
  }
}

// Poll telemetry every 6 seconds
updateTelemetry();
setInterval(updateTelemetry, 6000);

// 2. Drag & Drop / File Selection
browseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => {
  if (e.target !== browseBtn) fileInput.click();
});

['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (dt && dt.files.length > 0) {
    handleFileSelected(dt.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleFileSelected(fileInput.files[0]);
  }
});

changeFileBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  previewCard.classList.add('hidden');
  dropZone.classList.remove('hidden');
  printSubmitBtn.disabled = true;
  printSubmitText.textContent = 'Select a File to Print';
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function handleFileSelected(file) {
  if (!file) return;

  const validTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  const ext = file.name.split('.').pop().toLowerCase();
  const validExts = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];

  if (!validTypes.includes(file.type) && !validExts.includes(ext)) {
    alert('Please upload a PDF document or a valid image (PNG, JPG, WEBP).');
    return;
  }

  if (file.size > 25 * 1024 * 1024) {
    alert('File size exceeds the 25MB limit. Please choose a smaller file.');
    return;
  }

  selectedFile = file;

  // Show Preview Card
  dropZone.classList.add('hidden');
  previewCard.classList.remove('hidden');

  previewFileName.textContent = file.name;
  previewFileSize.textContent = formatBytes(file.size);
  fileTypeBadge.textContent = ext.toUpperCase();

  // Reset visual canvas / img
  pdfCanvas.classList.add('hidden');
  imagePreview.classList.add('hidden');
  previewFooter.classList.add('hidden');
  previewLoading.classList.remove('hidden');

  printSubmitBtn.disabled = false;
  printSubmitText.textContent = '🖨️ Print Document';

  if (ext === 'pdf' || file.type === 'application/pdf') {
    renderPdfPreview(file);
  } else {
    renderImagePreview(file);
  }
}

function renderImagePreview(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreview.src = e.target.result;
    imagePreview.classList.remove('hidden');
    previewLoading.classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

async function renderPdfPreview(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    pdfPageCount.textContent = `Page 1 of ${pdf.numPages}`;
    previewFooter.classList.remove('hidden');

    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.2 });

    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;

    const ctx = pdfCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    previewLoading.classList.add('hidden');
    pdfCanvas.classList.remove('hidden');
  } catch (err) {
    console.error('PDF preview error:', err);
    previewLoading.textContent = 'Preview unavailable (File ready for printing)';
  }
}

// 3. Quick Presets Bar
const presetsMap = {
  'normal-bw': {
    name: 'Normal B&W',
    pageSize: 'A4',
    mediaType: 'PLAIN_NORMAL',
    ink: 'MONO',
    copies: 1,
    orientation: 'auto',
    fitToPage: true,
    pageRange: 'All',
  },
  'color-high': {
    name: 'Color High',
    pageSize: 'A4',
    mediaType: 'PLAIN_HIGH',
    ink: 'COLOR',
    copies: 1,
    orientation: 'auto',
    fitToPage: true,
    pageRange: 'All',
  },
  'photo-4x6': {
    name: 'Photo 4x6',
    pageSize: '4X6FULL',
    mediaType: 'PMPHOTO_HIGH',
    ink: 'COLOR',
    copies: 1,
    orientation: 'auto',
    fitToPage: true,
    pageRange: 'All',
  },
  'draft-bw': {
    name: 'Draft B&W',
    pageSize: 'A4',
    mediaType: 'PLAIN_NORMAL',
    ink: 'MONO',
    copies: 1,
    orientation: 'auto',
    fitToPage: false,
    pageRange: 'All',
  },
};

presetButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetKey = btn.dataset.preset;
    const preset = presetsMap[presetKey];
    if (!preset) return;

    // Set Active Preset Style
    presetButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activePresetBadge.textContent = preset.name;

    // Apply settings
    Object.assign(currentSettings, preset);
    syncSettingsToInputs();
  });
});

function syncSettingsToInputs() {
  pageSizeSelect.value = currentSettings.pageSize;
  mediaTypeSelect.value = currentSettings.mediaType;

  inkButtons.forEach((b) => {
    b.classList.toggle('active', b.dataset.ink === currentSettings.ink);
  });

  copiesInput.value = currentSettings.copies;

  orientButtons.forEach((b) => {
    b.classList.toggle('active', b.dataset.orient === currentSettings.orientation);
  });

  fitToPageToggle.checked = currentSettings.fitToPage;
  pageRangeInput.value = currentSettings.pageRange;
}

// 4. Detailed Settings Form Inputs
accordionToggle.addEventListener('click', () => {
  const isExpanded = accordionToggle.getAttribute('aria-expanded') === 'true';
  accordionToggle.setAttribute('aria-expanded', !isExpanded);
  settingsPanel.classList.toggle('collapsed', isExpanded);
});

pageSizeSelect.addEventListener('change', (e) => {
  currentSettings.pageSize = e.target.value;
  activePresetBadge.textContent = 'Custom';
});

mediaTypeSelect.addEventListener('change', (e) => {
  currentSettings.mediaType = e.target.value;
  activePresetBadge.textContent = 'Custom';
});

inkButtons.forEach((b) => {
  b.addEventListener('click', () => {
    inkButtons.forEach((btn) => btn.classList.remove('active'));
    b.classList.add('active');
    currentSettings.ink = b.dataset.ink;
    activePresetBadge.textContent = 'Custom';
  });
});

orientButtons.forEach((b) => {
  b.addEventListener('click', () => {
    orientButtons.forEach((btn) => btn.classList.remove('active'));
    b.classList.add('active');
    currentSettings.orientation = b.dataset.orient;
    activePresetBadge.textContent = 'Custom';
  });
});

copyMinus.addEventListener('click', () => {
  let val = parseInt(copiesInput.value, 10) || 1;
  if (val > 1) {
    val--;
    copiesInput.value = val;
    currentSettings.copies = val;
  }
});

copyPlus.addEventListener('click', () => {
  let val = parseInt(copiesInput.value, 10) || 1;
  if (val < 99) {
    val++;
    copiesInput.value = val;
    currentSettings.copies = val;
  }
});

copiesInput.addEventListener('change', () => {
  let val = Math.max(1, Math.min(99, parseInt(copiesInput.value, 10) || 1));
  copiesInput.value = val;
  currentSettings.copies = val;
});

fitToPageToggle.addEventListener('change', (e) => {
  currentSettings.fitToPage = e.target.checked;
  activePresetBadge.textContent = 'Custom';
});

pageRangeInput.addEventListener('input', (e) => {
  currentSettings.pageRange = e.target.value.trim() || 'All';
  activePresetBadge.textContent = 'Custom';
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

// 5. Print Execution & Progression Tracker
printSubmitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  // Open Progress Modal
  progressModal.classList.remove('hidden');
  resetTracker();

  try {
    // Step 1: Uploading
    updateStepUI('upload');
    statusMessageHeading.textContent = 'Uploading Document...';
    statusMessageDetail.textContent = 'Transferring file payload to Cloudflare KV Edge spool.';

    let res;
    let uploadSuccess = false;
    let lastError = null;

    // Strategy 1: Multipart/form-data upload
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('settings', JSON.stringify(currentSettings));

      res = await fetch('/api/print', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        uploadSuccess = true;
      } else {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        lastError = errJson.error || 'Upload rejected';
      }
    } catch (netErr) {
      lastError = netErr.message;
    }

    // Strategy 2: Resilient Base64 JSON fallback (bypasses browser multipart boundary bugs)
    if (!uploadSuccess) {
      statusMessageDetail.textContent = 'Retrying upload via resilient data channel...';
      const fileBase64 = await readFileAsBase64(selectedFile);
      res = await fetch('/api/print', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream',
          fileBase64,
          settings: currentSettings,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error || lastError || 'Server rejected file upload');
      }
    }

    const data = await res.json();
    currentJobId = data.jobId;
    trackerJobId.textContent = currentJobId;

    // Step 2: Queued in Cloud
    updateStepUI('queued');
    statusMessageHeading.textContent = 'Job Queued in Cloud Spool';
    statusMessageDetail.textContent = 'Awaiting polling dispatch to Raspberry Pi 5 agent.';

    // Start Polling Job Status
    startStatusPolling(currentJobId);
  } catch (err) {
    showJobFailed(err.message);
  }
});

function resetTracker() {
  [stepUpload, stepQueued, stepDownloading, stepPrinting].forEach((st) => {
    st.className = 'track-step';
  });
  statusSpinner.classList.remove('hidden');
  statusIconDone.classList.add('hidden');
  statusIconFailed.classList.add('hidden');
  modalCloseBtn.classList.add('hidden');
}

function updateStepUI(stage) {
  if (stage === 'upload') {
    stepUpload.className = 'track-step active';
  } else if (stage === 'queued') {
    stepUpload.className = 'track-step done';
    stepQueued.className = 'track-step active';
  } else if (stage === 'downloading') {
    stepUpload.className = 'track-step done';
    stepQueued.className = 'track-step done';
    stepDownloading.className = 'track-step active';
  } else if (stage === 'printing') {
    stepUpload.className = 'track-step done';
    stepQueued.className = 'track-step done';
    stepDownloading.className = 'track-step done';
    stepPrinting.className = 'track-step active';
  } else if (stage === 'completed') {
    stepUpload.className = 'track-step done';
    stepQueued.className = 'track-step done';
    stepDownloading.className = 'track-step done';
    stepPrinting.className = 'track-step done';
  }
}

function startStatusPolling(jobId) {
  if (statusPollTimer) clearInterval(statusPollTimer);

  statusPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok) return;

      const job = await res.json();
      const status = job.status;

      if (status === 'queued') {
        updateStepUI('queued');
        statusMessageHeading.textContent = 'Queued in Cloud';
        statusMessageDetail.textContent = 'Waiting for Raspberry Pi agent to fetch.';
      } else if (status === 'downloading') {
        updateStepUI('downloading');
        statusMessageHeading.textContent = 'Pi 5 Dispatching';
        statusMessageDetail.textContent = 'Agent is downloading payload and preparing CUPS spool.';
      } else if (status === 'printing') {
        updateStepUI('printing');
        statusMessageHeading.textContent = 'Printing on Epson L565';
        statusMessageDetail.textContent = 'Hardware printer active. Please collect your sheets.';
      } else if (status === 'completed') {
        clearInterval(statusPollTimer);
        showJobSuccess();
      } else if (status === 'failed') {
        clearInterval(statusPollTimer);
        showJobFailed(job.error || 'CUPS print pipeline error');
      }
    } catch (err) {
      console.warn('Status poll exception:', err);
    }
  }, 1500);
}

function showJobSuccess() {
  updateStepUI('completed');
  statusSpinner.classList.add('hidden');
  statusIconDone.classList.remove('hidden');
  statusMessageHeading.textContent = '🎉 Print Job Completed!';
  statusMessageDetail.textContent = 'Your document was successfully printed by the Epson L565.';
  modalCloseBtn.classList.remove('hidden');
  modalCloseBtn.textContent = 'Print Another Document';
  triggerConfetti();
}

function showJobFailed(errorMsg) {
  statusSpinner.classList.add('hidden');
  statusIconFailed.classList.remove('hidden');
  statusMessageHeading.textContent = 'Print Job Failed';
  statusMessageDetail.textContent = errorMsg || 'An error occurred during printing.';
  modalCloseBtn.classList.remove('hidden');
  modalCloseBtn.textContent = 'Dismiss / Try Again';
}

modalCloseBtn.addEventListener('click', () => {
  progressModal.classList.add('hidden');
  if (statusPollTimer) clearInterval(statusPollTimer);
});

// Simple Confetti Celebration
function triggerConfetti() {
  const count = 30;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.width = '10px';
    el.style.height = '10px';
    el.style.borderRadius = '50%';
    el.style.backgroundColor = ['#38bdf8', '#f472b6', '#facc15', '#34d399', '#a78bfa'][
      Math.floor(Math.random() * 5)
    ];
    el.style.left = `${50 + (Math.random() * 40 - 20)}%`;
    el.style.top = '50%';
    el.style.zIndex = '1500';
    el.style.pointerEvents = 'none';
    el.style.transition = 'all 1.2s cubic-bezier(0.25, 1, 0.5, 1)';
    document.body.appendChild(el);

    const destX = (Math.random() - 0.5) * window.innerWidth * 0.8;
    const destY = (Math.random() - 0.8) * window.innerHeight * 0.7;

    requestAnimationFrame(() => {
      el.style.transform = `translate(${destX}px, ${destY}px) scale(0)`;
      el.style.opacity = '0';
    });

    setTimeout(() => el.remove(), 1300);
  }
}

// 6. PWA Service Worker Registration & Install Prompt
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('ServiceWorker registration error:', err);
    });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  pwaInstallBanner.classList.remove('hidden');
});

pwaInstallBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      pwaInstallBanner.classList.add('hidden');
    }
    deferredInstallPrompt = null;
  }
});
