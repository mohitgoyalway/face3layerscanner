// INITIALIZE GLOBALS
let faceMesh, camera;

// ─── DIAGNOSTIC LOGGER ────────────────────────────────────────────────────────
const LOG_ENTRIES = []; // accumulates every entry for the current scan session

const LOG = (() => {
    const t0 = Date.now();
    const elapsedMs = () => Date.now() - t0;
    const ts = () => `+${(elapsedMs() / 1000).toFixed(2)}s`;
    const S = {
        title: 'color:#6c63ff;font-weight:bold;font-size:13px',
        ok:    'color:#00d4aa;font-weight:bold',
        warn:  'color:#ff9933;font-weight:bold',
        err:   'color:#ff4c4c;font-weight:bold',
        data:  'color:#aaddff',
        dim:   'color:#888',
        stub:  'background:#ff4c4c;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px',
    };

    function push(level, msg, data) {
        LOG_ENTRIES.push({
            elapsed: elapsedMs(),
            wallTime: new Date().toISOString(),
            level,
            msg,
            ...(data !== undefined ? { data } : {})
        });
    }

    return {
        section(label) {
            push('SECTION', label);
            console.log(`%c▶ [${ts()}] ${label}`, S.title);
        },
        ok(msg, data) {
            push('OK', msg, data);
            data !== undefined
                ? console.log(`%c  ✓ [${ts()}] ${msg}`, S.ok, data)
                : console.log(`%c  ✓ [${ts()}] ${msg}`, S.ok);
        },
        warn(msg, data) {
            push('WARN', msg, data);
            data !== undefined
                ? console.warn(`%c  ⚠ [${ts()}] ${msg}`, S.warn, data)
                : console.warn(`%c  ⚠ [${ts()}] ${msg}`, S.warn);
        },
        err(msg, data) {
            push('ERROR', msg, data);
            data !== undefined
                ? console.error(`%c  ✗ [${ts()}] ${msg}`, S.err, data)
                : console.error(`%c  ✗ [${ts()}] ${msg}`, S.err);
        },
        info(msg, data) {
            push('INFO', msg, data);
            data !== undefined
                ? console.log(`%c  • [${ts()}] ${msg}`, S.data, data)
                : console.log(`%c  • [${ts()}] ${msg}`, S.data);
        },
        dim(msg) {
            push('TRACE', msg);
            console.log(`%c    ${msg}`, S.dim);
        },
        table(label, obj) {
            push('TABLE', label, obj);
            console.log(`%c  ► ${label}`, S.data);
            console.table(obj);
        },
        stub(msg) {
            push('STUB', msg);
            console.log(`%c STUB DATA `, S.stub, msg);
        },
        group(label, fn) {
            push('GROUP_START', label);
            console.groupCollapsed(`[${ts()}] ${label}`);
            fn();
            console.groupEnd();
        },
    };
})();

async function sendLogToServer(scanMeta) {
    try {
        const payload = { scanMeta, entries: LOG_ENTRIES };
        const res = await fetch('/scan-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            LOG.ok('Log saved to server', { filename: json.filename });
            return json.filename;
        }
    } catch (e) {
        LOG.warn('Could not send log to server — download only', e.message);
    }
    return null;
}

function downloadLogAsFile() {
    const blob = new Blob([JSON.stringify({ entries: LOG_ENTRIES }, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `scan_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
// ──────────────────────────────────────────────────────────────────────────────

// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const startBtn = document.getElementById('startScanner');
const setupView = document.getElementById('setupView');
const scannerView = document.getElementById('scannerView');
const statusText = document.getElementById('statusText');
const statusIndicator = document.querySelector('.status-indicator');
const timerText = document.getElementById('timerText');
const progressBarFill = document.getElementById('progressBarFill');
const analysisOverlay = document.getElementById('analysisOverlay');
const liveRegionRow = document.getElementById('liveRegionRow');

const regionConfirmationView = document.getElementById('regionConfirmationView');
const regionImagesGrid = document.getElementById('regionImagesGrid');
const confirmRegionsBtn = document.getElementById('confirmRegionsBtn');
const retryScanBtn = document.getElementById('retryScanBtn');

const analysisView = document.getElementById('analysisView');
const resultsSection = document.getElementById('resultsSection');
const resultsGrid = document.getElementById('resultsGrid');
const resetBtn = document.getElementById('resetBtn');

const previewBPM = document.getElementById('previewBPM');
const previewResp = document.getElementById('previewResp');
const previewBlink = document.getElementById('previewBlink');
const deepProgressFill = document.getElementById('deepProgressFill');

const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

// SCAN STATE
let isAnalyzing = false;
const SCAN_DURATION = 15000;
let pulseSamples = [];
let respirationSamples = [];
let blinkCount = 0;
let eyeClosed = false;
let scanStartTime = 0;
let stabilizationFrames = 0;
let lostFrames = 0;
let lastLandmarks = null;
let captureGateState = { ok: false, reasons: [] };
let gateOpenSince = 0;              // timestamp when gate last transitioned to open
let stabilizationFaceImage = null;  // captured at stabilization (best centered frame)
let _pendingFaceImageBase64 = null; // held between completeScan → confirmRegions → proceedToAnalysis

// HD BUFFERING
const regionBuffers = {}; 
const regionLocks = {};
const previousSamples = {};
const MAX_BUFFER_SIZE = 10;

// CLINICAL REGION DEFINITIONS (Rigid Similarity & Consistent Zoom)
const REGIONS = [
    { 
        id: 'live-Forehead', name: 'Forehead', 
        indices: [10, 67, 109, 338, 297], 
        pad: 0.15,
        useBboxCrop: true,
        crop: {
            // Forehead ROI should sit above brows; shift crop upward.
            padX: 0.35,
            padY: 0.45,
            offsetY: -0.40,
            minFaceWidthRatio: 0.34,
            minFaceHeightRatio: 0.20
        },
        anchors: [10, 127, 356], 
        target: [[400, 200], [50, 600], [750, 600]], // Macro Zoom
        quality: 1.0,
        lockThreshold: 78
    },
    { 
        id: 'live-Nose', name: 'Nose', 
        indices: [168, 6, 197, 2, 102, 331], 
        pad: 0.2,
        anchors: [168, 102, 331], 
        target: [[400, 200], [200, 650], [600, 650]], // Macro Zoom
        quality: 1.0,
        lockThreshold: 80
    },
    {
        id: 'live-Left-Cheek', name: 'Left Cheek',
        indices: [116, 117, 118, 101, 123],
        pad: 0.25,
        useBboxCrop: true,
        crop: {
            minFaceWidthRatio:  0.25,
            minFaceHeightRatio: 0.18
        },
        anchors: [123, 117, 6], // Outer-Eye, Inner-Eye, Nose-Bridge (Rigid)
        target: [[100, 300], [500, 350], [400, 650]], // Proportional Zoom
        quality: 1.5,
        lockThreshold: 82
    },
    {
        id: 'live-Right-Cheek', name: 'Right Cheek',
        indices: [345, 346, 347, 330, 352],
        pad: 0.25,
        useBboxCrop: true,
        crop: {
            minFaceWidthRatio:  0.25,
            minFaceHeightRatio: 0.18
        },
        anchors: [352, 346, 6], // Outer-Eye, Inner-Eye, Nose-Bridge (Rigid)
        target: [[700, 300], [300, 350], [400, 650]], // Proportional Zoom
        quality: 1.5,
        lockThreshold: 82
    },
    {
        id: 'live-Chin', name: 'Chin',
        indices: [164, 18, 200, 152],
        pad: 0.2,
        useBboxCrop: true,
        crop: {
            padX: 0.28,
            padY: 0.35,
            offsetY: 0.30,
            minFaceWidthRatio: 0.28,
            minFaceHeightRatio: 0.18
        },
        anchors: [164, 57, 287],
        target: [[400, 200], [100, 600], [700, 600]], // Macro Zoom
        quality: 1.0,
        lockThreshold: 80
    },
    {
        id: 'live-Jawline', name: 'Jawline',
        // Full jawline arc: left outer → chin → right outer
        indices: [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397],
        pad: 0.15,
        useBboxCrop: true,
        crop: {
            padX: 0.22,
            padY: 0.20,
            offsetY: 0.18,         // shift crop slightly downward toward jaw
            minFaceWidthRatio: 0.58,
            minFaceHeightRatio: 0.14
        },
        anchors: [172, 397, 152], // left-jaw, right-jaw, chin-tip
        target: [[80, 280], [720, 280], [400, 680]],
        quality: 1.0,
        lockThreshold: 75          // slightly more lenient — wide flat region
    }
];

/* ---------------- INITIALIZATION ---------------- */

function initFaceMesh() {
    LOG.section('initFaceMesh()');
    const FaceMeshConstructor = window.FaceMesh || (window.faceMesh ? window.faceMesh.FaceMesh : null);
    if (!FaceMeshConstructor) {
        LOG.err('MediaPipe FaceMesh NOT loaded from CDN — scanner cannot start');
        console.error("MediaPipe FaceMesh not loaded from CDN.");
        return;
    }

    faceMesh = new FaceMeshConstructor({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    const options = {
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    };
    faceMesh.setOptions(options);
    LOG.ok('FaceMesh initialised', options);
    faceMesh.onResults(onResults);
    LOG.ok('onResults callback registered');
}

function startScanner() {
    LOG.section('startScanner() — BEGIN SCAN button clicked');
    setupView.classList.add('hidden');
    scannerView.classList.remove('hidden');

    if (!faceMesh) {
        LOG.warn('FaceMesh not ready at scan start — calling initFaceMesh()');
        initFaceMesh();
    }

    const CameraConstructor = window.Camera;
    if (!CameraConstructor) {
        LOG.err('MediaPipe Camera utility NOT loaded — cannot access webcam');
        console.error("MediaPipe Camera utility not loaded.");
        alert("Camera initialization failed. Please refresh.");
        return;
    }

    LOG.info('Requesting camera stream', { width: 1280, height: 720 });
    camera = new CameraConstructor(video, {
        onFrame: async () => {
            if (faceMesh && !isAnalyzing) {
                await faceMesh.send({image: video});
            }
        },
        width: 1280,
        height: 720
    });
    camera.start();
    LOG.ok('Camera.start() called — waiting for first frame');
}

/* ---------------- CORE SCAN LOOP ---------------- */

// Track first-face detection and periodic scan logs
let _firstFaceLogged = false;
let _lastPeriodicLog  = 0;
const PERIODIC_LOG_INTERVAL = 3000; // log biometrics every 3s during scan

function onResults(results) {
    if (isAnalyzing) return;

    // Canvas Sizing
    if (video.videoWidth > 0) {
        const containerWidth = video.offsetWidth;
        const containerHeight = video.offsetHeight;
        const videoRatio = video.videoWidth / video.videoHeight;
        const containerRatio = containerWidth / containerHeight;

        let actualWidth, actualHeight;
        if (containerRatio > videoRatio) {
            actualHeight = containerHeight;
            actualWidth = actualHeight * videoRatio;
        } else {
            actualWidth = containerWidth;
            actualHeight = actualWidth / videoRatio;
        }

        if (canvas.width !== actualWidth || canvas.height !== actualHeight) {
            canvas.width = actualWidth;
            canvas.height = actualHeight;
        }
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hasFace = results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0;

    if (hasFace) {
        lostFrames = 0;
        const landmarks = results.multiFaceLandmarks[0];
        lastLandmarks = landmarks;

        if (!_firstFaceLogged) {
            _firstFaceLogged = true;
            LOG.section('FACE DETECTED — first landmark set received');
            LOG.info('Landmark count', landmarks.length);
            LOG.info('Video stream dimensions', { width: video.videoWidth, height: video.videoHeight });
        }

        // DRAW MESH
        ctx.save();
        if (window.drawConnectors) {
            drawConnectors(ctx, landmarks, window.FACEMESH_TESSELATION, {color: 'rgba(255,255,255,0.25)', lineWidth: 0.5});
            drawConnectors(ctx, landmarks, window.FACEMESH_CONTOURS, {color: '#00d2ff', lineWidth: 1.2});
        }
        ctx.restore();

        // Compute gate every frame (used by oval and scan logic)
        captureGateState = computeCaptureGate(landmarks, video);
        drawFaceOval(ctx);

        // SCAN LOGIC
        if (scanStartTime > 0) {
            statusText.textContent = "DEEP BIOMETRIC SCAN ACTIVE";
            statusIndicator.classList.add('active');
            liveRegionRow.classList.remove('hidden');

            if (!captureGateState.ok) {
                LOG.warn('Capture gate BLOCKED — frame skipped', captureGateState.reasons);
            }

            const elapsed = Date.now() - scanStartTime;
            if (elapsed < SCAN_DURATION) {
                pulseSamples.push({ t: elapsed, g: getForeheadGreen(landmarks, video) });
                respirationSamples.push({ t: elapsed, y: landmarks[1].y });
                detectBlink(landmarks);
                updateLiveRegions(landmarks, video);

                // Live BPM
                if (pulseSamples.length > 60 && pulseSamples.length % 30 === 0) {
                    const bpm = calculateBPM(pulseSamples);
                    const display = document.getElementById('liveBPM');
                    if (display) display.textContent = bpm;
                }

                // Periodic diagnostic snapshot every 3s
                const now = Date.now();
                if (now - _lastPeriodicLog > PERIODIC_LOG_INTERVAL) {
                    _lastPeriodicLog = now;
                    const regionStatus = {};
                    REGIONS.forEach(r => {
                        const lock = regionLocks[r.id] || {};
                        const buf  = regionBuffers[r.id] || [];
                        regionStatus[r.name] = {
                            locked:  lock.locked,
                            quality: lock.quality || (buf[0]?.quality ?? '--'),
                            frames:  buf.length,
                        };
                    });
                    LOG.group(`SCAN PROGRESS @ ${(elapsed/1000).toFixed(1)}s / ${SCAN_DURATION/1000}s`, () => {
                        LOG.info('Pulse samples collected', pulseSamples.length);
                        LOG.info('Respiration samples collected', respirationSamples.length);
                        LOG.info('Blinks detected so far', blinkCount);
                        LOG.info('Capture gate', captureGateState);
                        LOG.table('Region lock status', regionStatus);
                    });
                }

                timerText.textContent = `${((SCAN_DURATION - elapsed) / 1000).toFixed(1)}s`;
                progressBarFill.style.width = `${(elapsed / SCAN_DURATION) * 100}%`;
            } else {
                completeScan();
            }
        } else {
            stabilizationFrames++;
            statusText.textContent = `STABILIZING... ${Math.round((stabilizationFrames/15)*100)}%`;
            if (stabilizationFrames >= 15) {
                LOG.section('STABILIZATION COMPLETE — 15 frames passed, scan starting');
                const faceW = Math.abs((landmarks[454]?.x ?? 0.8) - (landmarks[234]?.x ?? 0.2));
                const faceH = Math.abs((landmarks[152]?.y ?? 0.85) - (landmarks[10]?.y ?? 0.15));
                LOG.info('Face geometry at scan start', { faceWidth: faceW.toFixed(3), faceHeight: faceH.toFixed(3) });

                // Capture face image NOW while face is most centered and stable
                stabilizationFaceImage = captureCurrentFaceImageBase64();
                if (stabilizationFaceImage) {
                    LOG.ok('Stabilization face image captured', { sizeKB: Math.round(stabilizationFaceImage.length * 0.75 / 1024) + 'KB' });
                } else {
                    LOG.warn('Stabilization face image capture failed — video not ready yet');
                }

                scanStartTime = Date.now();
                analysisOverlay.classList.remove('hidden');
                REGIONS.forEach(r => {
                    regionBuffers[r.id] = [];
                    regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
                    previousSamples[r.id] = null;
                });
                LOG.info('Region buffers initialised for', REGIONS.map(r => r.name));
            } else {
                LOG.dim(`Stabilizing frame ${stabilizationFrames}/15`);
            }
        }
    } else {
        lostFrames++;
        drawFaceOval(ctx, true);
        if (lostFrames > 10) {
            if (lostFrames === 11) LOG.warn('Face LOST — searching for subject', { scanStarted: scanStartTime > 0 });
            statusText.textContent = "SEARCHING FOR SUBJECT...";
            statusIndicator.classList.remove('active');
            if (scanStartTime === 0) stabilizationFrames = 0;
        }
    }
}

/* ---------------- HD RECONSTRUCTION ---------------- */

function solveAffine(p, q) {
    const matrix = [
        [p[0].x, p[0].y, 1, 0, 0, 0],
        [0, 0, 0, p[0].x, p[0].y, 1],
        [p[1].x, p[1].y, 1, 0, 0, 0],
        [0, 0, 0, p[1].x, p[1].y, 1],
        [p[2].x, p[2].y, 1, 0, 0, 0],
        [0, 0, 0, p[2].x, p[2].y, 1]
    ];
    const rhs = [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]];
    const n = 6;
    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) if (Math.abs(matrix[k][i]) > Math.abs(matrix[maxRow][i])) maxRow = k;
        [matrix[i], matrix[maxRow]] = [matrix[maxRow], matrix[i]];
        [rhs[i], rhs[maxRow]] = [rhs[maxRow], rhs[i]];
        if (Math.abs(matrix[i][i]) < 1e-10) return [1, 0, 0, 0, 1, 0];
        for (let k = i + 1; k < n; k++) {
            const c = -matrix[k][i] / matrix[i][i];
            for (let j = i; j < n; j++) matrix[k][j] += c * matrix[i][j];
            rhs[k] += c * rhs[i];
        }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = 0;
        for (let j = i + 1; j < n; j++) sum += matrix[i][j] * x[j];
        x[i] = (rhs[i] - sum) / matrix[i][i];
    }
    return x;
}

function triangleArea(a, b, c) {
    return Math.abs((a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2);
}

function isValidTransform(m) {
    if (!Array.isArray(m) || m.length !== 6 || m.some(v => !Number.isFinite(v))) return false;
    const det = (m[0] * m[4]) - (m[1] * m[3]);
    return Number.isFinite(det) && Math.abs(det) > 1e-4 && Math.abs(det) < 500;
}

function drawRegionFallback(region, landmarks, video) {
    const points = region.indices
        .map(idx => landmarks[idx])
        .filter(Boolean)
        .map(p => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }));

    if (!points.length) return;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const width = Math.max(2, maxX - minX);
    const height = Math.max(2, maxY - minY);
    const crop = region.crop || {};
    const padX = width * (crop.padX ?? region.pad ?? 0.2);
    const padY = height * (crop.padY ?? region.pad ?? 0.2);
    const offsetX = width * (crop.offsetX ?? 0);
    const offsetY = height * (crop.offsetY ?? 0);
    const faceWidth = Math.abs((landmarks[454]?.x ?? 0.8) - (landmarks[234]?.x ?? 0.2)) * video.videoWidth;
    const faceHeight = Math.abs((landmarks[152]?.y ?? 0.85) - (landmarks[10]?.y ?? 0.15)) * video.videoHeight;

    const centerX = ((minX + maxX) / 2) + offsetX;
    const centerY = ((minY + maxY) / 2) + offsetY;
    const minW = (crop.minFaceWidthRatio ?? 0) * faceWidth;
    const minH = (crop.minFaceHeightRatio ?? 0) * faceHeight;
    const targetW = Math.max(width + (padX * 2), minW || 0);
    const targetH = Math.max(height + (padY * 2), minH || 0);

    const sx = Math.max(0, centerX - (targetW / 2));
    const sy = Math.max(0, centerY - (targetH / 2));
    const sw = Math.max(2, Math.min(video.videoWidth - sx, targetW));
    const sh = Math.max(2, Math.min(video.videoHeight - sy, targetH));

    offscreenCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 800, 800);
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function computeCaptureGate(landmarks, video) {
    const faceWidth = Math.abs((landmarks[454]?.x ?? 0.8) - (landmarks[234]?.x ?? 0.2));
    const faceHeight = Math.abs((landmarks[152]?.y ?? 0.85) - (landmarks[10]?.y ?? 0.15));
    const nose = landmarks[1];
    const left = landmarks[234];
    const right = landmarks[454];
    const top = landmarks[10];
    const chin = landmarks[152];

    const leftDist = Math.abs((nose?.x ?? 0.5) - (left?.x ?? 0.2));
    const rightDist = Math.abs((right?.x ?? 0.8) - (nose?.x ?? 0.5));
    const yawAsymmetry = Math.abs(leftDist - rightDist) / Math.max(1e-6, leftDist + rightDist);
    const noseVertical = ((nose?.y ?? 0.5) - (top?.y ?? 0.15)) / Math.max(1e-6, (chin?.y ?? 0.85) - (top?.y ?? 0.15));
    const pitchDeviation = Math.abs(noseVertical - 0.52);

    const reasons = [];
    if (faceWidth < 0.24) reasons.push("Move closer");
    if (faceWidth > 0.72) reasons.push("Move slightly back");
    if (faceHeight < 0.30) reasons.push("Center face vertically");
    if (yawAsymmetry > 0.26) reasons.push("Face camera straight");
    if (pitchDeviation > 0.24) reasons.push("Keep head level");

    return {
        ok: reasons.length === 0,
        reasons
    };
}

function drawFaceOval(ctx, noFace) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    const isMobile = window.innerWidth < 768;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rx = w * (isMobile ? 0.26 : 0.22);
    const ry = h * (isMobile ? 0.42 : 0.38);

    let strokeColor;
    if (noFace) {
        strokeColor = 'rgba(255,255,255,0.25)';
        gateOpenSince = 0;
    } else if (!captureGateState.ok) {
        strokeColor = '#ff4444';
        gateOpenSince = 0;
    } else {
        if (gateOpenSince === 0) gateOpenSince = Date.now();
        strokeColor = (Date.now() - gateOpenSince) > 2000 ? '#00e676' : '#ffaa00';
    }

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isMobile ? 4 : 3;
    ctx.shadowColor = strokeColor;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
}

function analyzeSampleQuality(regionId, imgData, sampleSize, nowTs) {
    const data = imgData;
    const pixelCount = sampleSize * sampleSize;
    const rowStride = sampleSize * 4;

    let lumSum = 0;
    let lumSqSum = 0;
    let gradSum = 0;
    let brightCount = 0;
    let darkCount = 0;
    let motionDiffSum = 0;

    const prev = previousSamples[regionId];
    const hasPrev = prev && prev.length === data.length;

    for (let y = 0; y < sampleSize - 1; y++) {
        for (let x = 0; x < sampleSize - 1; x++) {
            const i = ((y * sampleSize) + x) * 4;
            const lum = (0.299 * data[i]) + (0.587 * data[i + 1]) + (0.114 * data[i + 2]);
            const lumX = (0.299 * data[i + 4]) + (0.587 * data[i + 5]) + (0.114 * data[i + 6]);
            const lumY = (0.299 * data[i + rowStride]) + (0.587 * data[i + rowStride + 1]) + (0.114 * data[i + rowStride + 2]);

            lumSum += lum;
            lumSqSum += (lum * lum);
            gradSum += Math.abs(lum - lumX) + Math.abs(lum - lumY);
            if (lum > 245) brightCount++;
            if (lum < 28) darkCount++;

            if (hasPrev) {
                const prevLum = (0.299 * prev[i]) + (0.587 * prev[i + 1]) + (0.114 * prev[i + 2]);
                motionDiffSum += Math.abs(lum - prevLum);
            }
        }
    }

    // Cache this sample for motion estimate in the next frame.
    previousSamples[regionId] = new Uint8ClampedArray(data);

    const validPixels = (sampleSize - 1) * (sampleSize - 1);
    const meanLum = lumSum / Math.max(1, validPixels);
    const variance = Math.max(0, (lumSqSum / Math.max(1, validPixels)) - (meanLum * meanLum));
    const contrastStd = Math.sqrt(variance);
    const gradMean = gradSum / Math.max(1, (validPixels * 2));
    const glareFrac = brightCount / Math.max(1, validPixels);
    const darkFrac = darkCount / Math.max(1, validPixels);
    const motionMean = hasPrev ? (motionDiffSum / Math.max(1, validPixels)) : 0;

    const sharpnessScore = clamp01(gradMean / 26);
    const contrastScore = clamp01(contrastStd / 42);
    const exposureScore = clamp01(1 - (Math.abs(meanLum - 132) / 132));
    const glareScore = clamp01(1 - (glareFrac / 0.09));
    const occlusionScore = clamp01(1 - (darkFrac / 0.35));
    const stabilityScore = clamp01(1 - (motionMean / 22));
    const qualityScore = (
        (sharpnessScore * 0.35) +
        (contrastScore * 0.15) +
        (exposureScore * 0.15) +
        (glareScore * 0.10) +
        (occlusionScore * 0.10) +
        (stabilityScore * 0.15)
    );

    return {
        score: Math.round(qualityScore * 100),
        sharpnessRaw: gradMean
    };
}

function updateLiveRegions(landmarks, video) {
    if (offscreenCanvas.width !== 800) { offscreenCanvas.width = 800; offscreenCanvas.height = 800; }
    REGIONS.forEach(r => {
        const liveCanvas = document.getElementById(r.id);
        if (!liveCanvas) return;
        const liveCtx = liveCanvas.getContext('2d', { willReadFrequently: true });
        if (liveCanvas.width !== 800) { liveCanvas.width = 800; liveCanvas.height = 800; regionBuffers[r.id] = []; }
        if (!regionLocks[r.id]) regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
        const lockState = regionLocks[r.id];

        const indicator = liveCanvas.parentElement.querySelector('.refining-indicator');
        if (lockState.locked) {
            if (indicator) {
                indicator.textContent = `ULTRA-HD LOCKED (${lockState.quality})`;
                indicator.style.color = '#55ff55';
            }
            return;
        }

        const srcPoints = r.anchors.map(idx => ({ x: landmarks[idx].x * video.videoWidth, y: landmarks[idx].y * video.videoHeight }));
        const m = solveAffine(srcPoints, r.target);

        // Prevent stale pixels bleeding between regions/frames.
        offscreenCtx.setTransform(1, 0, 0, 1, 0, 0);
        offscreenCtx.clearRect(0, 0, 800, 800);

        const srcArea = triangleArea(srcPoints[0], srcPoints[1], srcPoints[2]);
        if (!r.useBboxCrop && srcArea > 10 && isValidTransform(m)) {
            offscreenCtx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
            offscreenCtx.drawImage(video, 0, 0);
            offscreenCtx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
            // BBox path avoids catastrophic shearing/flipping for unstable regions (especially cheeks).
            drawRegionFallback(r, landmarks, video);
        }

        const sampleSize = 200;
        const imgData = offscreenCtx.getImageData(300, 300, sampleSize, sampleSize).data;
        const nowTs = Date.now();
        const quality = analyzeSampleQuality(r.id, imgData, sampleSize, nowTs);

        const qualityMultiplier = r.quality || 1.0; 

        const buffer = regionBuffers[r.id];
        const gateBlocked = !captureGateState.ok;
        if (gateBlocked) {
            if (indicator) {
                indicator.textContent = captureGateState.reasons[0] || 'HOLD STEADY';
                indicator.style.color = '#ffcf66';
            }
            return;
        }

        const effectiveScore = quality.score / qualityMultiplier;
        if (buffer.length < MAX_BUFFER_SIZE || effectiveScore > buffer[buffer.length - 1].score) {
            buffer.push({ score: effectiveScore, quality: quality.score, data: offscreenCtx.getImageData(0, 0, 800, 800), ts: nowTs });
            buffer.sort((a, b) => b.score - a.score);
            if (buffer.length > MAX_BUFFER_SIZE) buffer.pop();
            
            // ZERO GHOSTING: Always show the single sharpest frame at 100% opacity
            liveCtx.globalAlpha = 1.0;
            liveCtx.drawImage(offscreenCanvas, 0, 0);

            if (quality.score >= (r.lockThreshold || 80) && buffer.length >= 3) {
                lockState.locked = true;
                lockState.quality = quality.score;
                lockState.ts = nowTs;
                LOG.ok(`Region LOCKED: ${r.name}`, { quality: quality.score, threshold: r.lockThreshold, framesInBuffer: buffer.length });
                // Log how many regions are now locked total
                const lockedCount = REGIONS.filter(reg => regionLocks[reg.id]?.locked).length;
                LOG.info(`Locked regions: ${lockedCount} / ${REGIONS.length}`);
            }
        }

        if (indicator) {
            if (lockState.locked) {
                indicator.textContent = `ULTRA-HD LOCKED (${lockState.quality})`;
                indicator.style.color = '#55ff55';
            } else {
                indicator.textContent = `QUALITY ${quality.score} | ${Math.min(100, buffer.length * 10)}%`;
                indicator.style.color = quality.score >= 70 ? '#55ff55' : '#00d2ff';
            }
        }
    });
}

function calculateMedianImageData(buffer) {
    if (buffer.length === 0) return null;
    // Avoid blur from mixing different poses/occlusions (e.g., glasses on/off); use sharpest frame.
    return buffer[0].data;
}

function calculateLegacyMedianImageData(buffer) {
    if (buffer.length === 0) return null;
    const width = buffer[0].data.width, height = buffer[0].data.height, size = width * height * 4;
    const result = new Uint8ClampedArray(size), numFrames = buffer.length;
    for (let i = 0; i < size; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            const values = [];
            for (let f = 0; f < numFrames; f++) values.push(buffer[f].data.data[i + channel]);
            values.sort((a, b) => a - b);
            result[i + channel] = values[Math.floor(numFrames / 2)];
        }
        result[i + 3] = 255; 
    }
    return new ImageData(result, width, height);
}

/* ---------------- UTILS & LIFECYCLE ---------------- */

function detectBlink(landmarks) {
    const ear = Math.abs(landmarks[159].y - landmarks[145].y) / Math.abs(landmarks[33].x - landmarks[133].x);
    if (ear < 0.14) { if (!eyeClosed) { eyeClosed = true; blinkCount++; } } else { eyeClosed = false; }
}

function getForeheadGreen(landmarks, video) {
    const fx = landmarks[151].x * video.videoWidth, fy = landmarks[151].y * video.videoHeight;
    offscreenCtx.drawImage(video, fx - 20, fy - 10, 40, 20, 0, 0, 40, 20);
    const d = offscreenCtx.getImageData(0, 0, 40, 20).data;
    let g = 0; for (let i = 1; i < d.length; i += 4) g += d[i];
    return g / (d.length / 4);
}

function captureCurrentFaceImageBase64() {
    if (!video.videoWidth || !video.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
}

function completeScan() {
    isAnalyzing = true;
    LOG.section('completeScan() — 15s scan finished');

    // Log final region lock summary
    const lockSummary = {};
    REGIONS.forEach(r => {
        const lock = regionLocks[r.id] || {};
        const buf  = regionBuffers[r.id] || [];
        lockSummary[r.name] = { locked: lock.locked, quality: lock.quality, framesBuffered: buf.length };
    });
    LOG.table('Final region lock summary', lockSummary);

    const unlockedRegions = REGIONS.filter(r => !regionLocks[r.id]?.locked).map(r => r.name);
    if (unlockedRegions.length) {
        LOG.warn('Regions NOT locked by scan end', unlockedRegions);
    } else {
        LOG.ok('All regions successfully locked');
    }

    // Use the stabilization-phase face image (most centered frame), not the current frame
    _pendingFaceImageBase64 = stabilizationFaceImage;
    LOG.info('Using stabilization face image for HF', { present: !!_pendingFaceImageBase64 });

    scannerView.classList.add('hidden');
    liveRegionRow.classList.add('hidden');

    // Show region confirmation view before proceeding to analysis
    populateRegionConfirmation();
    regionConfirmationView.classList.remove('hidden');
    LOG.ok('Region confirmation view shown — awaiting user confirmation');
}

function populateRegionConfirmation() {
    regionImagesGrid.innerHTML = '';
    REGIONS.forEach(r => {
        const buf  = regionBuffers[r.id] || [];
        const lock = regionLocks[r.id] || {};

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';

        const label = document.createElement('div');
        label.textContent = r.name.toUpperCase();
        label.style.cssText = 'font-size:0.7rem;letter-spacing:2px;color:#aaa;font-family:Montserrat,sans-serif;';

        const cnv = document.createElement('canvas');
        cnv.width  = 200;
        cnv.height = 200;
        cnv.style.cssText = 'width:100%;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:#0d0d1a;';

        const badge = document.createElement('div');
        badge.style.cssText = 'font-size:0.65rem;letter-spacing:1px;font-family:Montserrat,sans-serif;';

        if (buf.length > 0 && buf[0].data) {
            // Draw the best locked frame scaled down from 800×800 → 200×200
            const tmp = document.createElement('canvas');
            tmp.width = 800; tmp.height = 800;
            tmp.getContext('2d').putImageData(buf[0].data, 0, 0);
            cnv.getContext('2d').drawImage(tmp, 0, 0, 800, 800, 0, 0, 200, 200);
            badge.textContent  = lock.locked ? `LOCKED ✓  Q:${lock.quality}` : `BEST FRAME  Q:${Math.round(buf[0].quality ?? 0)}`;
            badge.style.color  = lock.locked ? '#00d4aa' : '#ff9933';
        } else {
            const ctx = cnv.getContext('2d');
            ctx.fillStyle = '#0d0d1a';
            ctx.fillRect(0, 0, 200, 200);
            ctx.fillStyle = '#555';
            ctx.font = 'bold 13px Montserrat,sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('NO DATA', 100, 100);
            badge.textContent = 'NOT CAPTURED';
            badge.style.color = '#ff4c4c';
        }

        wrapper.appendChild(label);
        wrapper.appendChild(cnv);
        wrapper.appendChild(badge);
        regionImagesGrid.appendChild(wrapper);
    });
}

async function proceedToAnalysis() {
    LOG.section('proceedToAnalysis() — user confirmed regions, computing biometrics & posting to backend');

    // faceImageBase64 was captured at stabilization and stored
    const faceImageBase64 = _pendingFaceImageBase64;

    regionConfirmationView.classList.add('hidden');
    analysisView.classList.remove('hidden');

    const bpm    = calculateBPM(pulseSamples);
    const resp   = calculateRespiration(respirationSamples);
    const blinks = Math.round((blinkCount / (SCAN_DURATION / 1000)) * 60);

    LOG.group('Computed biometrics', () => {
        LOG.info('Pulse samples used', pulseSamples.length);
        LOG.info('Respiration samples used', respirationSamples.length);
        LOG.info('Raw blink count', blinkCount);
        LOG.info('BPM (null = too few samples)', bpm);
        LOG.info('Respiration br/m (null = too few samples)', resp);
        LOG.info('Blink rate blinks/m', blinks);
    });

    previewBPM.textContent   = bpm   ?? '--';
    previewResp.textContent  = resp  ?? '--';
    previewBlink.textContent = blinks ?? '--';

    // ⚠ STUB DATA — regions are still hardcoded, now includes jawline
    const stubRegions = {
        forehead:    { gloss_reflectance_score: 0.2, wrinkle_depth_index: 0.1, erythema_index: 0.2, texture_variance: 0.3 },
        nose:        { gloss_reflectance_score: 0.6, pore_diameter_variance: 0.5 },
        chin:        { erythema_index: 0.3, hydration_proxy: 0.6 },
        left_cheek:  { pih_density: 0.15, melanin_variance_score: 0.2, hydration_proxy: 0.7, texture_variance: 0.25 },
        right_cheek: { pih_density: 0.12, melanin_variance_score: 0.18, hydration_proxy: 0.72, texture_variance: 0.22 },
        jawline:     { papule_density: 0.1, pustule_density: 0.05, erythema_index: 0.2, wrinkle_depth_index: 0.08, sagging_index: 0.1 }
    };
    const stubGlobal = { age: 30, gender: "female", environment_type: "urban" };

    LOG.stub('regions{} is HARDCODED — includes jawline now but still not computed from captured images.');
    LOG.stub('global.age and global.gender are HARDCODED — HF age inference may override age if token is set.');

    const payload = {
        regions:           stubRegions,
        global:            stubGlobal,
        biometrics:        { bpm, respiration: resp, blinkRate: blinks },
        face_image_base64: faceImageBase64
    };

    LOG.group('FULL PAYLOAD BEING SENT TO POST /analyze-face', () => {
        LOG.info('regions (keys present)', Object.keys(payload.regions));
        LOG.info('global', payload.global);
        LOG.info('biometrics (real data)', payload.biometrics);
        LOG.info('face_image_base64 source', faceImageBase64 ? 'stabilization snapshot' : 'none');
        LOG.warn('biometrics are REAL values but backend ignores them — not yet wired into any service');
        const payloadSizeKB = Math.round(JSON.stringify({ ...payload, face_image_base64: '...' }).length / 1024);
        LOG.info('Payload size (excl. image)', payloadSizeKB + ' KB');
    });

    let deepProgress = 0;
    const deepTimer = setInterval(() => { deepProgress += 2; deepProgressFill.style.width = `${Math.min(deepProgress, 98)}%`; }, 100);

    try {
        LOG.info('Sending POST /analyze-face...');
        const fetchStart = Date.now();

        const response = await fetch('/analyze-face', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const fetchMs = Date.now() - fetchStart;
        LOG.ok(`Response received in ${fetchMs}ms`, { status: response.status, ok: response.ok });

        clearInterval(deepTimer);
        if (!response.ok) {
            let errorMessage = `Request failed (${response.status})`;
            try {
                const errorPayload = await response.json();
                errorMessage = errorPayload.message || errorMessage;
            } catch (_) {}
            LOG.err('Backend returned error', { status: response.status, message: errorMessage });
            throw new Error(errorMessage);
        }

        const result = await response.json();

        LOG.group('BACKEND RESPONSE', () => {
            LOG.info('success', result.success);
            LOG.info('confidence', result.confidence + '%');
            LOG.info('age_estimation', result.age_estimation);
            LOG.info('demographics', result.demographics);
            LOG.info('dermatology_summary', result.dermatology_summary);
            const pillarTable = {};
            Object.entries(result.pillars || {}).forEach(([k, v]) => {
                pillarTable[k] = { score: v?.score, state: v?.state, driver: v?.driver_region };
            });
            LOG.table('Pillar scores', pillarTable);
            if (result.confidence < 50) LOG.warn('Confidence below 50% — very few metrics received by backend');
            const nullPillars = Object.entries(result.pillars || {}).filter(([, v]) => !v).map(([k]) => k);
            if (nullPillars.length) LOG.warn('Pillars returned null (no region data matched)', nullPillars);
        });

        // Save scan log to server, then show results with download button
        const scanMeta = {
            scanDate: new Date().toISOString(),
            bpm, resp, blinks,
            regionLockSummary: Object.fromEntries(REGIONS.map(r => [r.name, regionLocks[r.id] || {}])),
            backendResult: { confidence: result.confidence, age_estimation: result.age_estimation, dermatology_summary: result.dermatology_summary }
        };
        const savedFilename = await sendLogToServer(scanMeta);
        LOG.ok('Scan complete — proceeding to results');

        setTimeout(() => {
            analysisView.classList.add('hidden');
            showResults(result, { bpm, resp, blinks }, faceImageBase64, savedFilename);
        }, 1000);
    } catch (err) {
        clearInterval(deepTimer);
        LOG.err('Fetch/analysis failed', err.message);
        alert(`Analysis Error: ${err.message}`);
        resetScanner();
    }
}

function calculateBPM(samples) {
    // Need at least 30 samples (~1s of data) to attempt a calculation
    if (samples.length < 30) {
        LOG.warn('calculateBPM: too few samples for any estimate', { samples: samples.length });
        return null;
    }
    const signal   = samples.map(s => s.g);
    const filtered = detrend(signal, 5);
    const smoothed = movingAverage(filtered, 3);
    let peaks = 0;
    const threshold = getStandardDeviation(smoothed) * 0.8;
    for (let i = 2; i < smoothed.length - 2; i++) {
        if (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1] && smoothed[i] > threshold) {
            peaks++;
            i += 5;
        }
    }
    const durationSecs = (samples[samples.length - 1].t - samples[0].t) / 1000;
    if (durationSecs < 0.5) return null;
    const bpm = Math.round((peaks / durationSecs) * 60);
    const reliable = samples.length >= 100;
    if (!reliable) LOG.warn('calculateBPM: result may be noisy — fewer than 100 samples', { samples: samples.length, bpm });
    return Math.min(Math.max(bpm, 40), 130); // wider range: don't over-clamp low-sample results
}

function movingAverage(arr, window) {
    let res = [];
    for (let i = 0; i < arr.length; i++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - window); j <= Math.min(arr.length - 1, i + window); j++) { sum += arr[j]; count++; }
        res.push(sum / count);
    }
    return res;
}

function getStandardDeviation(array) {
    const mean = array.reduce((a, b) => a + b) / array.length;
    return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / array.length);
}

function calculateRespiration(samples) {
    if (samples.length < 20) {
        LOG.warn('calculateRespiration: too few samples', { samples: samples.length });
        return null;
    }
    const d = detrend(samples.map(s => s.y), 20);
    let c = 0;
    for (let i = 1; i < d.length; i++) {
        if ((d[i-1] < 0 && d[i] >= 0) || (d[i-1] > 0 && d[i] <= 0)) c++;
    }
    const durationSecs = (samples[samples.length - 1].t - samples[0].t) / 1000 || (SCAN_DURATION / 1000);
    const resp = Math.min(Math.max(Math.round((c / 2 / durationSecs) * 60), 8), 30);
    if (samples.length < 50) LOG.warn('calculateRespiration: result may be imprecise — fewer than 50 samples', { samples: samples.length, resp });
    return resp;
}

function detrend(arr, w) {
    const res = [];
    for (let i = 0; i < arr.length; i++) {
        const start = Math.max(0, i - w), end = Math.min(arr.length - 1, i + w);
        let s = 0; for (let j = start; j <= end; j++) s += arr[j];
        res.push(arr[i] - (s / (end - start + 1)));
    }
    return res;
}

function showResults(data, vitals, submittedFaceImageBase64 = null, savedLogFilename = null) {
    LOG.section('showResults() — rendering results UI');
    LOG.info('Vitals displayed to user', vitals);
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
    resultsSection.classList.remove('hidden');
    resultsGrid.innerHTML = '';

    let total = 0, count = 0;
    Object.values(data.pillars || {}).forEach(p => {
        if (p && typeof p.score === 'number') {
            total += p.score;
            count++;
        }
    });

    const overall = count > 0 ? Math.round(total / count) : 85;
    const hero = document.createElement('div');
    hero.className = 'wellness-hero';
    hero.style.cssText = 'grid-column:1/-1;background:rgba(236,97,14,0.07);border:1px solid rgba(236,97,14,0.2);';
    hero.innerHTML = `
        <h1 style="font-size:4rem;line-height:1;margin-bottom:8px;color:#F5EDE6;">${overall}</h1>
        <p style="font-size:0.72rem;font-weight:600;letter-spacing:0.06em;color:#7A6055;text-transform:uppercase;">Overall Wellness Index</p>
    `;
    resultsGrid.appendChild(hero);

    const vitalsCard = document.createElement('div');
    vitalsCard.className = 'result-card';
    vitalsCard.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);';
    vitalsCard.innerHTML = `
        <h3>Scan Biometrics</h3>
        <p>Heart Rate: <strong>${vitals.bpm ?? '--'} BPM</strong>${vitals.bpm === null ? ' <span style="font-size:0.72rem;color:#F0A030">(insufficient data)</span>' : ''}</p>
        <p>Respiration: <strong>${vitals.resp ?? '--'} br/m</strong>${vitals.resp === null ? ' <span style="font-size:0.72rem;color:#F0A030">(insufficient data)</span>' : ''}</p>
        <p>Blink Rate: <strong>${vitals.blinks ?? '--'} blinks/m</strong></p>
    `;
    resultsGrid.appendChild(vitalsCard);

    const metaCard = document.createElement('div');
    metaCard.className = 'result-card';
    metaCard.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);';
    const demographics = data.demographics || {};
    const summary = data.dermatology_summary || {};
    const estimatedAge = data.age_estimation?.estimated_age;
    metaCard.innerHTML = `
        <h3>Clinical Summary</h3>
        <p>Confidence: <strong>${data.confidence ?? '--'}%</strong></p>
        <p>Estimated Age: <strong>${estimatedAge ?? '--'}</strong></p>
        <p>Profile: <strong>${demographics.age ?? '--'} / ${demographics.gender ?? '--'}</strong></p>
        <p>Finding: <strong style="color:#EC610E;">${summary.primary_finding || 'Maintenance & Prevention'}</strong></p>
    `;
    resultsGrid.appendChild(metaCard);

    if (submittedFaceImageBase64) {
        const imageCard = document.createElement('div');
        imageCard.className = 'result-card';
        imageCard.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);';
        imageCard.innerHTML = `
            <h3>Image Sent to Age Model</h3>
            <img
                src="${submittedFaceImageBase64}"
                alt="Face frame sent to Hugging Face"
                style="width:100%;max-height:240px;object-fit:contain;border-radius:10px;border:1px solid rgba(236,97,14,0.2);background:#000;margin-top:8px;"
            />
        `;
        resultsGrid.appendChild(imageCard);
    }

    Object.entries(data.pillars || {}).forEach(([pillarName, pillar]) => {
        if (!pillar) return;
        const card = document.createElement('div');
        card.className = 'result-card';
        card.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);';
        card.innerHTML = `
            <h3>${pillarName.replaceAll('_', ' ')}</h3>
            <p>Score: <strong style="color:#EC610E;">${pillar.score}</strong></p>
            <p>State: <strong>${pillar.state}</strong></p>
            <p>Region: <strong>${pillar.driver_region || 'NA'}</strong></p>
            <p style="margin-top:8px;font-size:0.83rem;">${pillar.insight || ''}</p>
        `;
        resultsGrid.appendChild(card);
    });

    const foot = document.createElement('div');
    foot.style.cssText = 'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:12px;';
    foot.appendChild(resetBtn);

    // Log download / server link
    const logRow = document.createElement('div');
    logRow.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center;';

    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'DOWNLOAD SCAN LOG';
    dlBtn.style.cssText = 'font-size:0.72rem;letter-spacing:1.5px;padding:8px 18px;border:1px solid rgba(108,99,255,0.5);background:transparent;color:#6c63ff;border-radius:6px;cursor:pointer;font-family:Montserrat,sans-serif;';
    dlBtn.addEventListener('click', downloadLogAsFile);
    logRow.appendChild(dlBtn);

    if (savedLogFilename) {
        const serverNote = document.createElement('span');
        serverNote.textContent = `Log saved on server: ${savedLogFilename}`;
        serverNote.style.cssText = 'font-size:0.7rem;color:#555;font-family:Montserrat,sans-serif;';
        logRow.appendChild(serverNote);
    }

    foot.appendChild(logRow);
    resultsGrid.appendChild(foot);
}

function resetScanner() {
    LOG.section('resetScanner() — full state reset');
    isAnalyzing = false;
    _firstFaceLogged = false;
    _lastPeriodicLog  = 0;
    stabilizationFaceImage   = null;
    _pendingFaceImageBase64  = null;
    LOG_ENTRIES.length = 0; // clear log for the next scan session
    resultsSection.classList.add('hidden'); analysisView.classList.add('hidden'); regionConfirmationView.classList.add('hidden');
    setupView.classList.remove('hidden'); analysisOverlay.classList.add('hidden'); liveRegionRow.classList.add('hidden');
    scanStartTime = 0;
    stabilizationFrames = 0;
    lostFrames = 0;
    lastLandmarks = null;
    eyeClosed = false;
    captureGateState = { ok: false, reasons: [] };
    gateOpenSince = 0;
    pulseSamples = [];
    respirationSamples = [];
    blinkCount = 0;

    // Reset visible scan/analysis UI state so next run starts clean.
    statusText.textContent = "INITIALIZING...";
    statusIndicator.classList.remove('active');
    timerText.textContent = `${(SCAN_DURATION / 1000).toFixed(1)}s`;
    progressBarFill.style.width = '0%';
    deepProgressFill.style.width = '0%';
    previewBPM.textContent = '--';
    previewResp.textContent = '--';
    previewBlink.textContent = '--';
    const liveBPM = document.getElementById('liveBPM');
    if (liveBPM) liveBPM.textContent = '--';

    // Clear per-region image buffers and canvases.
    REGIONS.forEach(r => {
        regionBuffers[r.id] = [];
        regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
        previousSamples[r.id] = null;
        const liveCanvas = document.getElementById(r.id);
        if (liveCanvas) {
            const ctx = liveCanvas.getContext('2d');
            ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
        }
        const indicator = liveCanvas?.parentElement?.querySelector('.refining-indicator');
        if (indicator) {
            indicator.textContent = 'RECONSTRUCTING...';
            indicator.style.color = '#00d2ff';
        }
    });

    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
}

// ATTACH LISTENERS
startBtn.addEventListener('click', startScanner);
resetBtn.addEventListener('click', resetScanner);
confirmRegionsBtn.addEventListener('click', () => proceedToAnalysis()); // uses _pendingFaceImageBase64 internally
retryScanBtn.addEventListener('click', resetScanner);

// INIT ON LOAD
window.addEventListener('DOMContentLoaded', () => {
    LOG.section('PAGE LOADED — DOMContentLoaded fired');

    // Verify every critical DOM element is present
    const domChecks = {
        video, canvas, startBtn, setupView, scannerView, statusText,
        statusIndicator, timerText, progressBarFill, analysisOverlay,
        liveRegionRow, regionConfirmationView, regionImagesGrid,
        confirmRegionsBtn, retryScanBtn, analysisView, resultsSection,
        resultsGrid, resetBtn, previewBPM, previewResp, previewBlink,
        deepProgressFill
    };
    const missing = Object.entries(domChecks).filter(([, el]) => !el).map(([k]) => k);
    if (missing.length) {
        LOG.err('Missing DOM elements — check index.html IDs', missing);
    } else {
        LOG.ok('All DOM elements found');
    }

    LOG.info('MediaPipe availability check', {
        FaceMesh: !!(window.FaceMesh || window.faceMesh),
        Camera:   !!window.Camera,
        drawConnectors: !!window.drawConnectors,
    });

    initFaceMesh();
});
