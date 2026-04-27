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
const regionReadyCount = document.getElementById('regionReadyCount');
const mobileScanProgress = document.getElementById('mobileScanProgress');
const instructionOverlay = document.getElementById('instructionOverlay');

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
let prevGateWasOpen = false;        // tracks previous frame gate state for haptic trigger
let lightingWarning = null;         // 'dark' | 'bright' | null — set during stabilization
let coveringDetected = null;        // 'shades' | 'mask' | null — face accessory occlusion
const bestRegionCategory = {};      // regionId → 0..3, only ever increases during a scan
let goodScanMs = 0;                 // accumulated ms of gate-open time (real scan progress)
let lastGoodFrameTime = 0;          // wall-clock time of last gate-open frame
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
        lockThreshold: 82
    },
    {
        id: 'live-Nose', name: 'Nose',
        indices: [168, 6, 197, 2, 102, 331],
        pad: 0.2,
        anchors: [168, 102, 331],
        target: [[400, 200], [200, 650], [600, 650]], // Macro Zoom
        quality: 1.0,
        lockThreshold: 82
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
        lockThreshold: 82
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
        lockThreshold: 78
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

        // Compute gate before drawing mesh so mesh color reflects current state
        captureGateState = computeCaptureGate(landmarks, video);
        coveringDetected  = detectFaceCovering(landmarks, video);

        // Haptic: single 80ms buzz the moment gate transitions closed → open (mobile only)
        if (captureGateState.ok && !prevGateWasOpen) {
            if ('vibrate' in navigator && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
                navigator.vibrate(80);
            }
        }
        prevGateWasOpen = captureGateState.ok;

        // Mesh color follows gate state: red blocked → orange just opened → green locked in
        let meshColor;
        if (!captureGateState.ok) {
            gateOpenSince = 0;
            meshColor = '#ff4444';
        } else {
            if (gateOpenSince === 0) gateOpenSince = Date.now();
            meshColor = (Date.now() - gateOpenSince) > 2000 ? '#00e676' : '#ffaa00';
        }

        // DRAW MESH
        ctx.save();
        if (window.drawConnectors) {
            const tesselationAlpha = meshColor === '#ff4444' ? 0.18 : 0.28;
            const rgb = meshColor === '#ff4444' ? '255,68,68'
                      : meshColor === '#ffaa00' ? '255,170,0'
                      : '0,230,118';
            drawConnectors(ctx, landmarks, window.FACEMESH_TESSELATION, {color: `rgba(${rgb},${tesselationAlpha})`, lineWidth: 0.5});
            drawConnectors(ctx, landmarks, window.FACEMESH_CONTOURS,    {color: meshColor, lineWidth: 1.2});
        }
        ctx.restore();

        updateInstructionOverlay();

        // SCAN LOGIC
        if (scanStartTime > 0) {
            statusText.textContent = "DEEP BIOMETRIC SCAN ACTIVE";
            statusIndicator.classList.add('active');

            if (!captureGateState.ok) {
                LOG.warn('Capture gate BLOCKED — frame skipped', captureGateState.reasons);
                lastGoodFrameTime = 0;
            }

            // Accumulate good scan time only while gate is open
            if (captureGateState.ok) {
                const now = Date.now();
                if (lastGoodFrameTime > 0) goodScanMs += now - lastGoodFrameTime;
                lastGoodFrameTime = now;
            }

            if (goodScanMs < SCAN_DURATION) {
                pulseSamples.push({ t: goodScanMs, g: getForeheadGreen(landmarks, video) });
                respirationSamples.push({ t: goodScanMs, y: landmarks[1].y });
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
                    LOG.group(`SCAN PROGRESS @ ${(goodScanMs/1000).toFixed(1)}s good / ${SCAN_DURATION/1000}s`, () => {
                        LOG.info('Pulse samples collected', pulseSamples.length);
                        LOG.info('Respiration samples collected', respirationSamples.length);
                        LOG.info('Blinks detected so far', blinkCount);
                        LOG.info('Capture gate', captureGateState);
                        LOG.table('Region lock status', regionStatus);
                    });
                }

                timerText.textContent = `${((SCAN_DURATION - goodScanMs) / 1000).toFixed(1)}s`;
                progressBarFill.style.width = `${(goodScanMs / SCAN_DURATION) * 100}%`;
            } else {
                completeScan();
            }
        } else {
            // Run lighting check on frames 3–8 of stabilization
            if (stabilizationFrames >= 3 && stabilizationFrames <= 8) {
                lightingWarning = checkLighting();
            }

            // Block scan start while lighting is bad; reset counter so user can fix and retry
            if (lightingWarning === 'dark') {
                stabilizationFrames = 0;
                statusText.textContent = 'CHECK LIGHTING';
                return;
            }
            if (lightingWarning === 'bright') {
                stabilizationFrames = 0;
                statusText.textContent = 'CHECK LIGHTING';
                return;
            }

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
                goodScanMs = 0;
                lastGoodFrameTime = 0;
                analysisOverlay.classList.remove('hidden');
                REGIONS.forEach(r => {
                    regionBuffers[r.id] = [];
                    regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
                    previousSamples[r.id] = null;
                    bestRegionCategory[r.id] = 0;
                });

                // Mobile: show compact progress list instead of live video tiles
                if (window.innerWidth < 768) {
                    if (mobileScanProgress) {
                        mobileScanProgress.querySelectorAll('.msp-item').forEach(el => {
                            el.setAttribute('data-state', '0');
                            el.querySelector('.msp-state').textContent = 'NOT DETECTED';
                        });
                        mobileScanProgress.classList.remove('hidden');
                    }
                } else {
                    liveRegionRow.classList.remove('hidden');
                    if (regionReadyCount) regionReadyCount.classList.remove('hidden');
                }
                LOG.info('Region buffers initialised for', REGIONS.map(r => r.name));
            } else {
                LOG.dim(`Stabilizing frame ${stabilizationFrames}/15`);
            }
        }
    } else {
        lostFrames++;
        coveringDetected = null;
        updateInstructionOverlay(true);
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
    const faceWidth  = Math.abs((landmarks[454]?.x ?? 0.8) - (landmarks[234]?.x ?? 0.2));
    const faceHeight = Math.abs((landmarks[152]?.y ?? 0.85) - (landmarks[10]?.y ?? 0.15));
    const nose  = landmarks[1];
    const left  = landmarks[234];
    const right = landmarks[454];
    const top   = landmarks[10];
    const chin  = landmarks[152];

    const leftDist  = Math.abs((nose?.x ?? 0.5) - (left?.x  ?? 0.2));
    const rightDist = Math.abs((right?.x ?? 0.8) - (nose?.x  ?? 0.5));
    const yawAsymmetry   = Math.abs(leftDist - rightDist) / Math.max(1e-6, leftDist + rightDist);
    const noseVertical   = ((nose?.y ?? 0.5) - (top?.y ?? 0.15)) / Math.max(1e-6, (chin?.y ?? 0.85) - (top?.y ?? 0.15));
    const pitchDeviation = Math.abs(noseVertical - 0.52);

    // Vertical centering: where the face mid-point sits in the frame (0 = top, 1 = bottom)
    const faceCenterY = ((top?.y ?? 0.5) + (chin?.y ?? 0.5)) / 2;

    const reasons = [];
    if (faceWidth < 0.30)      reasons.push("Move closer");
    if (faceWidth > 0.72)      reasons.push("Move slightly back");
    if (faceHeight < 0.25)     reasons.push("Show your full face");   // truly cropped — lower threshold than before
    if (faceCenterY < 0.28)    reasons.push("Lower the camera");      // face sitting too high
    if (faceCenterY > 0.72)    reasons.push("Raise the camera");      // face sitting too low
    if (yawAsymmetry > 0.26)   reasons.push("Face camera straight");
    if (pitchDeviation > 0.24) reasons.push("Keep head level");

    return { ok: reasons.length === 0, reasons };
}

function checkLighting() {
    if (offscreenCanvas.width < 100 || offscreenCanvas.height < 100) return null;
    offscreenCanvas.width = offscreenCanvas.width; // clear
    offscreenCanvas.width = 100; offscreenCanvas.height = 100;
    offscreenCtx.drawImage(video, 0, 0, 100, 100);
    const pixels = offscreenCtx.getImageData(20, 20, 60, 60).data;
    let sum = 0;
    const count = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
        sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
    const avg = sum / count;
    if (avg < 40)  return 'dark';
    if (avg > 220) return 'bright';
    return null;
}

function detectFaceCovering(landmarks, video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;

    const px = (idx) => ({ x: landmarks[idx].x * vw, y: landmarks[idx].y * vh });

    // Sample a zone from video into a small patch; return { mean, std } of luminance
    function sampleZone(x, y, w, h) {
        if (w < 4 || h < 4) return null;
        const cW = Math.min(w, 40), cH = Math.min(h, 40);
        offscreenCanvas.width = cW;
        offscreenCanvas.height = cH;
        offscreenCtx.drawImage(video, x, y, w, h, 0, 0, cW, cH);
        const d = offscreenCtx.getImageData(0, 0, cW, cH).data;
        let lumSum = 0, lumSqSum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            lumSum += lum; lumSqSum += lum * lum; n++;
        }
        const mean = lumSum / Math.max(1, n);
        return { mean, std: Math.sqrt(Math.max(0, lumSqSum / Math.max(1, n) - mean * mean)) };
    }

    // Forehead reference zone
    const top = px(10), browL = px(107), browR = px(336), tempL = px(234), tempR = px(454);
    const fh = sampleZone(
        Math.max(0, Math.round(tempL.x + (tempR.x - tempL.x) * 0.15)),
        Math.max(0, Math.round(top.y)),
        Math.max(4, Math.round((tempR.x - tempL.x) * 0.70)),
        Math.max(4, Math.round((browL.y - top.y) * 0.80))
    );
    if (!fh || fh.mean < 25) return null; // too dark — lighting warning handles this

    // Eye zone (between brow arches and lower eyelids, full eye width)
    const browArchL = px(70), browArchR = px(300);
    const eyeOutL = px(33), eyeOutR = px(263), eyeLowL = px(145), eyeLowR = px(374);
    const eyeY = Math.max(0, Math.round(Math.min(browArchL.y, browArchR.y)));
    const eye = sampleZone(
        Math.max(0, Math.round(eyeOutL.x)),
        eyeY,
        Math.max(4, Math.round(eyeOutR.x - eyeOutL.x)),
        Math.max(4, Math.round(Math.max(eyeLowL.y, eyeLowR.y) - eyeY))
    );

    // Lower face zone (nose tip → chin, between inner jaw landmarks)
    const noseTip = px(1), chin = px(152), jawL = px(57), jawR = px(287);
    const lf = sampleZone(
        Math.max(0, Math.round(jawL.x)),
        Math.max(0, Math.round(noseTip.y)),
        Math.max(4, Math.round(jawR.x - jawL.x)),
        Math.max(4, Math.round(chin.y - noseTip.y))
    );

    // Shades / dark sunglasses: eye zone ≥45% darker than forehead
    if (eye && fh.mean > 55 && eye.mean < fh.mean * 0.52) return 'shades';

    // Mask: lower face is very uniform (fabric) AND clearly different tone from forehead
    if (lf && lf.std < 14 && Math.abs(lf.mean - fh.mean) > 28 && fh.mean > 55) return 'mask';

    return null;
}

function updateInstructionOverlay(noFace) {
    if (!instructionOverlay) return;

    let text, color;

    if (lightingWarning === 'dark') {
        text  = 'TOO DARK — MOVE TO BETTER LIGHTING';
        color = '#ffcf66';
    } else if (lightingWarning === 'bright') {
        text  = 'BRIGHT LIGHT BEHIND YOU — TURN AROUND';
        color = '#ffcf66';
    } else if (noFace) {
        text  = 'POSITION YOUR FACE IN THE FRAME';
        color = '#ffcf66';
    } else if (coveringDetected === 'shades') {
        text  = 'REMOVE SUNGLASSES — FULL FACE MUST BE VISIBLE';
        color = '#ffcf66';
    } else if (coveringDetected === 'mask') {
        text  = 'REMOVE MASK — FULL FACE MUST BE VISIBLE';
        color = '#ffcf66';
    } else if (!captureGateState.ok) {
        const reason = captureGateState.reasons[0] || '';
        if      (reason.includes('closer'))     { text = 'MOVE CLOSER';               color = '#ffffff'; }
        else if (reason.includes('back'))       { text = 'MOVE BACK SLIGHTLY';        color = '#ffffff'; }
        else if (reason.includes('full face'))  { text = 'SHOW YOUR FULL FACE';       color = '#ffffff'; }
        else if (reason.includes('Lower'))      { text = 'LOWER THE CAMERA SLIGHTLY'; color = '#ffffff'; }
        else if (reason.includes('Raise'))      { text = 'RAISE THE CAMERA SLIGHTLY'; color = '#ffffff'; }
        else if (reason.includes('straight'))   { text = 'FACE THE CAMERA DIRECTLY';  color = '#ffffff'; }
        else if (reason.includes('level'))      { text = 'KEEP HEAD LEVEL';           color = '#ffffff'; }
        else                                    { text = 'ADJUST YOUR POSITION';      color = '#ffffff'; }
    } else {
        const heldMs = gateOpenSince > 0 ? Date.now() - gateOpenSince : 0;
        if (heldMs < 1500) {
            text  = 'PERFECT — HOLD STILL';
            color = '#00e676';
        } else if (scanStartTime > 0) {
            text  = 'SCANNING…';
            color = '#00d2ff';
        } else {
            text  = 'HOLD STILL';
            color = '#00e676';
        }
    }

    instructionOverlay.textContent = text;
    instructionOverlay.style.color = color;
    instructionOverlay.classList.remove('hidden');
}

// Per-region scoring weights: [sharpness, glare, exposure, occlusion, stability, contrast]
const REGION_WEIGHTS = {
    'live-Forehead':    [0.46, 0.28, 0.10, 0.09, 0.04, 0.03],
    'live-Nose':        [0.46, 0.28, 0.10, 0.09, 0.04, 0.03],
    'live-Left-Cheek':  [0.48, 0.15, 0.15, 0.10, 0.05, 0.07],
    'live-Right-Cheek': [0.48, 0.15, 0.15, 0.10, 0.05, 0.07],
    'live-Chin':        [0.48, 0.15, 0.10, 0.18, 0.06, 0.03],
    'live-Jawline':     [0.48, 0.15, 0.10, 0.22, 0.07, 0.03],
};
const WEIGHTS_DEFAULT = [0.50, 0.20, 0.10, 0.10, 0.05, 0.05];

function analyzeSampleQuality(regionId, imgData, sampleSize, nowTs) {
    const data = imgData;
    const rowStride = sampleSize * 4;

    let lumSum = 0;
    let lumSqSum = 0;
    let gradSum = 0;
    let clipLowCount = 0;   // lum 0-5
    let clipHighCount = 0;  // lum 250-255
    let darkCount = 0;      // lum < 28
    let glareCount = 0;     // HSV specular: V>0.90 && S<0.15
    let rSum = 0, gSum = 0, bSum = 0;
    let motionDiffSum = 0;

    const prev = previousSamples[regionId];
    const hasPrev = prev && prev.length === data.length;

    // 4×4 grid for uniformity: accumulate lum per cell
    const GRID = 4;
    const cellSize = Math.floor(sampleSize / GRID);
    const cellLumSum = new Float32Array(GRID * GRID);
    const cellCounts = new Int32Array(GRID * GRID);

    for (let y = 0; y < sampleSize - 1; y++) {
        for (let x = 0; x < sampleSize - 1; x++) {
            const i = ((y * sampleSize) + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = (0.299 * r) + (0.587 * g) + (0.114 * b);
            const lumX = (0.299 * data[i + 4]) + (0.587 * data[i + 5]) + (0.114 * data[i + 6]);
            const lumY = (0.299 * data[i + rowStride]) + (0.587 * data[i + rowStride + 1]) + (0.114 * data[i + rowStride + 2]);

            lumSum += lum;
            lumSqSum += (lum * lum);
            gradSum += Math.abs(lum - lumX) + Math.abs(lum - lumY);
            rSum += r; gSum += g; bSum += b;

            if (lum <= 5)   clipLowCount++;
            if (lum >= 250) clipHighCount++;
            if (lum < 28)   darkCount++;

            // HSV-based specular glare: compute V and S from RGB
            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const V = maxC / 255;
            const S = maxC > 0 ? (maxC - minC) / maxC : 0;
            if (V > 0.90 && S < 0.15) glareCount++;

            // 4×4 grid cell accumulation
            const cx = Math.min(Math.floor(x / cellSize), GRID - 1);
            const cy = Math.min(Math.floor(y / cellSize), GRID - 1);
            cellLumSum[cy * GRID + cx] += lum;
            cellCounts[cy * GRID + cx]++;

            if (hasPrev) {
                const prevLum = (0.299 * prev[i]) + (0.587 * prev[i + 1]) + (0.114 * prev[i + 2]);
                motionDiffSum += Math.abs(lum - prevLum);
            }
        }
    }

    previousSamples[regionId] = new Uint8ClampedArray(data);

    const validPixels = (sampleSize - 1) * (sampleSize - 1);
    const meanLum = lumSum / Math.max(1, validPixels);
    const variance = Math.max(0, (lumSqSum / Math.max(1, validPixels)) - (meanLum * meanLum));
    const contrastStd = Math.sqrt(variance);
    const gradMean = gradSum / Math.max(1, validPixels * 2);
    const glareFrac = glareCount / Math.max(1, validPixels);
    const darkFrac = darkCount / Math.max(1, validPixels);
    const motionMean = hasPrev ? (motionDiffSum / Math.max(1, validPixels)) : 0;

    // Exposure: clipping penalty + 4×4 uniformity penalty
    const clipFrac = (clipLowCount + clipHighCount) / Math.max(1, validPixels);
    const clipPenalty = clamp01(clipFrac / 0.08);
    const cellMeans = cellLumSum.map((s, idx) => s / Math.max(1, cellCounts[idx]));
    const cellMeanAvg = cellMeans.reduce((a, b) => a + b, 0) / cellMeans.length;
    const cellVariance = cellMeans.reduce((s, v) => s + (v - cellMeanAvg) ** 2, 0) / cellMeans.length;
    const uniformityPenalty = clamp01(Math.sqrt(cellVariance) / 60);
    const exposureScore = clamp01(1 - (clipPenalty * 0.6 + uniformityPenalty * 0.4));

    const sharpnessScore = clamp01(gradMean / 26);
    const contrastScore = clamp01(contrastStd / 42);
    const glareScore = clamp01(1 - (glareFrac / 0.07));
    const occlusionScore = clamp01(1 - (darkFrac / 0.35));
    const stabilityScore = clamp01(1 - (motionMean / 22));

    const W = REGION_WEIGHTS[regionId] || WEIGHTS_DEFAULT;
    const qualityScore =
        sharpnessScore  * W[0] +
        glareScore      * W[1] +
        exposureScore   * W[2] +
        occlusionScore  * W[3] +
        stabilityScore  * W[4] +
        contrastScore   * W[5];

    // White-balance sanity (informational — returned for future use)
    const meanR = rSum / Math.max(1, validPixels);
    const meanG = gSum / Math.max(1, validPixels);
    const meanB = bSum / Math.max(1, validPixels);
    let wbWarning = null;
    if (meanG / Math.max(1, meanR) > 2.0)  wbWarning = 'fluorescent';
    else if (meanB / Math.max(1, meanG) > 1.8) wbWarning = 'cold-led';
    else if (meanR / Math.max(1, meanB) > 2.5)  wbWarning = 'warm-incandescent';

    return {
        score: Math.round(qualityScore * 100),
        sharpnessRaw: gradMean,
        wbWarning
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

        const tile = liveCanvas.parentElement;
        const indicator = tile.querySelector('.refining-indicator');
        if (lockState.locked) {
            tile.style.borderColor = 'rgba(0,230,118,0.8)';
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
            tile.style.borderColor = 'rgba(255,255,255,0.12)';
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

        if (lockState.locked) {
            tile.style.borderColor = 'rgba(0,230,118,0.8)';
        } else if (buffer.length > 0) {
            tile.style.borderColor = 'rgba(236,97,14,0.7)';
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

    // Update regions-ready counter (desktop only — hidden on mobile via CSS)
    if (regionReadyCount) {
        const locked = REGIONS.filter(r => regionLocks[r.id]?.locked).length;
        const total  = REGIONS.length;
        regionReadyCount.classList.remove('hidden', 'all-locked');
        if (locked === 0) {
            regionReadyCount.textContent = 'Positioning…';
            regionReadyCount.style.color = '';
        } else if (locked < total - 1) {
            regionReadyCount.textContent = `${locked} of ${total} regions locked`;
            regionReadyCount.style.color = '#F0A030';
        } else if (locked === total - 1) {
            regionReadyCount.textContent = `${locked} of ${total} regions locked — almost done`;
            regionReadyCount.style.color = '#a0e080';
        } else {
            regionReadyCount.textContent = `ALL ${total} REGIONS LOCKED ✓`;
            regionReadyCount.style.color = '#00e676';
            regionReadyCount.classList.add('all-locked');
        }
    }

    // Update mobile progress list (only meaningful when visible)
    if (mobileScanProgress && !mobileScanProgress.classList.contains('hidden')) {
        const CAT_LABELS = ['NOT DETECTED', 'LOW QUALITY', 'GOOD QUALITY', 'LOCKED ✓'];
        REGIONS.forEach(r => {
            const lock   = regionLocks[r.id] || {};
            const buf    = regionBuffers[r.id] || [];
            const best   = buf.length > 0 ? buf[0].quality : 0;

            let cat = 0;
            if (lock.locked)       cat = 3;
            else if (best >= 55)   cat = 2;
            else if (best > 0)     cat = 1;

            // Category can only go up within a scan
            if (cat > (bestRegionCategory[r.id] || 0)) bestRegionCategory[r.id] = cat;
            const displayCat = bestRegionCategory[r.id] || 0;

            const item = mobileScanProgress.querySelector(`[data-region="${r.id}"]`);
            if (!item) return;
            if (parseInt(item.getAttribute('data-state')) !== displayCat) {
                item.setAttribute('data-state', displayCat);
                item.querySelector('.msp-state').textContent = CAT_LABELS[displayCat];
            }
        });
    }
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
    if (mobileScanProgress) mobileScanProgress.classList.add('hidden');
    if (instructionOverlay) instructionOverlay.classList.add('hidden');

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
    if (regionReadyCount) { regionReadyCount.classList.add('hidden'); regionReadyCount.classList.remove('all-locked'); regionReadyCount.textContent = 'Positioning…'; regionReadyCount.style.color = ''; }
    if (instructionOverlay) instructionOverlay.classList.add('hidden');
    if (mobileScanProgress) {
        mobileScanProgress.classList.add('hidden');
        mobileScanProgress.querySelectorAll('.msp-item').forEach(el => {
            el.setAttribute('data-state', '0');
            el.querySelector('.msp-state').textContent = 'NOT DETECTED';
        });
    }
    REGIONS.forEach(r => { bestRegionCategory[r.id] = 0; });
    scanStartTime = 0;
    stabilizationFrames = 0;
    lostFrames = 0;
    lastLandmarks = null;
    eyeClosed = false;
    captureGateState = { ok: false, reasons: [] };
    gateOpenSince = 0;
    prevGateWasOpen = false;
    lightingWarning = null;
    coveringDetected = null;
    goodScanMs = 0;
    lastGoodFrameTime = 0;
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
        const tile = liveCanvas?.parentElement;
        if (tile) tile.style.borderColor = '';
        const indicator = tile?.querySelector('.refining-indicator');
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
