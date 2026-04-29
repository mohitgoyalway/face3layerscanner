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
const setupInstruction = document.querySelector('#setupView .instruction');
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
const DEFAULT_SETUP_INSTRUCTION = setupInstruction?.textContent || 'Scan your face for instant insights on oiliness, texture, marks, sensitivity, and breakout-prone areas.';
const DEFAULT_START_BUTTON_TEXT = startBtn?.textContent || 'START SKIN SCAN';

// SCAN STATE
let isAnalyzing = false;
const SCAN_DURATION  = 15000;
const SCAN_EXTENSION = 10000; // extra ms allowed if <4 regions reach good quality by 15s
const SCAN_PROGRESS_RING_GAP = 0.08;
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
let lightingColourWarning = null;   // 'fluorescent' | 'cold-led' | null — harsh light colour
let shineAdvisory = false;          // true when T-zone glare is consistently high pre-scan
let shineFrameCount = 0;            // how many stabilisation frames showed high shine
let coveringDetected = null;        // 'shades' | 'mask' | null — face accessory occlusion
let skinBaseline = null;            // { r, g, b } — forehead skin tone baseline for this person
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
        lockThreshold: 76
    },
    {
        id: 'live-Nose', name: 'Nose',
        indices: [168, 6, 197, 2, 102, 331],
        pad: 0.2,
        anchors: [168, 102, 331],
        target: [[400, 200], [200, 650], [600, 650]], // Macro Zoom
        quality: 1.0,
        lockThreshold: 76
    },
    {
        id: 'live-Left-Cheek', name: 'Left Cheek',
        indices: [116, 117, 118, 101, 123],
        pad: 0.25,
        useBboxCrop: true,
        crop: {
            // Include outer cheek / side-face acne zone, not only front cheek.
            padX: 0.50,
            padY: 0.30,
            offsetX: -0.22,
            minFaceWidthRatio:  0.36,
            minFaceHeightRatio: 0.22
        },
        anchors: [123, 117, 6], // Outer-Eye, Inner-Eye, Nose-Bridge (Rigid)
        target: [[100, 300], [500, 350], [400, 650]], // Proportional Zoom
        quality: 1.5,
        lockThreshold: 74
    },
    {
        id: 'live-Right-Cheek', name: 'Right Cheek',
        indices: [345, 346, 347, 330, 352],
        pad: 0.25,
        useBboxCrop: true,
        crop: {
            // Include outer cheek / side-face acne zone, not only front cheek.
            padX: 0.50,
            padY: 0.30,
            offsetX: 0.22,
            minFaceWidthRatio:  0.36,
            minFaceHeightRatio: 0.22
        },
        anchors: [352, 346, 6], // Outer-Eye, Inner-Eye, Nose-Bridge (Rigid)
        target: [[700, 300], [300, 350], [400, 650]], // Proportional Zoom
        quality: 1.5,
        lockThreshold: 74
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
        lockThreshold: 76
    },
    {
        id: 'live-Jawline', name: 'Jawline',
        // Full jawline arc: left outer → chin → right outer
        indices: [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397],
        pad: 0.15,
        useBboxCrop: true,
        crop: {
            // Wider/taller lower-face crop to include side jaw acne zones.
            padX: 0.30,
            padY: 0.48,
            offsetY: 0.02,
            minFaceWidthRatio: 0.66,
            minFaceHeightRatio: 0.26
        },
        anchors: [172, 397, 152], // left-jaw, right-jaw, chin-tip
        target: [[80, 280], [720, 280], [400, 680]],
        quality: 1.0,
        lockThreshold: 72
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

function getCameraStartupMessage(error) {
    const name = error?.name || '';

    if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) {
        return 'Camera permission is blocked. Allow camera access in your browser settings, then try again.';
    }
    if (['NotFoundError', 'DevicesNotFoundError'].includes(name)) {
        return 'No camera was found. Connect a camera and try again.';
    }
    if (['NotReadableError', 'TrackStartError'].includes(name)) {
        return 'Camera is already in use or unavailable. Close other apps using it, then try again.';
    }
    if (['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(name)) {
        return 'This camera does not support the requested scan settings. Try another camera or browser.';
    }
    if (name === 'MediaPipeUnavailable') {
        return 'Face detection did not load. Check your connection and refresh the page.';
    }
    if (name === 'CameraUtilityUnavailable') {
        return 'Camera controls did not load. Check your connection and refresh the page.';
    }

    return 'Camera could not start. Check browser permission and try again.';
}

function handleCameraStartupError(error) {
    const message = getCameraStartupMessage(error);
    LOG.err('Camera startup failed', {
        name: error?.name || 'UnknownError',
        message: error?.message || String(error || ''),
        userMessage: message
    });

    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }

    camera = null;
    isAnalyzing = false;
    document.body.classList.remove('scan-active');
    scannerView.classList.add('hidden');
    analysisOverlay.classList.add('hidden');
    liveRegionRow.classList.add('hidden');
    if (mobileScanProgress) mobileScanProgress.classList.add('hidden');
    if (instructionOverlay) instructionOverlay.classList.add('hidden');
    setupView.classList.remove('hidden');

    statusText.textContent = 'CAMERA UNAVAILABLE';
    statusIndicator.classList.remove('active');
    if (setupInstruction) setupInstruction.textContent = message;
    startBtn.textContent = 'TRY AGAIN';
    startBtn.disabled = false;
}

function startScanner() {
    LOG.section('startScanner() — start skin scan button clicked');
    startBtn.disabled = true;
    startBtn.textContent = DEFAULT_START_BUTTON_TEXT;
    if (setupInstruction) setupInstruction.textContent = DEFAULT_SETUP_INSTRUCTION;
    setupView.classList.add('hidden');
    scannerView.classList.remove('hidden');
    document.body.classList.add('scan-active');

    if (!faceMesh) {
        LOG.warn('FaceMesh not ready at scan start — calling initFaceMesh()');
        initFaceMesh();
    }
    if (!faceMesh) {
        handleCameraStartupError({ name: 'MediaPipeUnavailable', message: 'FaceMesh constructor unavailable' });
        return;
    }

    const CameraConstructor = window.Camera;
    if (!CameraConstructor) {
        LOG.err('MediaPipe Camera utility NOT loaded — cannot access webcam');
        handleCameraStartupError({ name: 'CameraUtilityUnavailable', message: 'MediaPipe Camera utility unavailable' });
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
    // Defer camera.start() by two paint frames so the browser paints the
    // scan-active expanded layout before the camera permission dialog appears.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
            const startResult = camera.start();
            if (startResult && typeof startResult.then === 'function') {
                startResult
                    .then(() => {
                        startBtn.disabled = false;
                        LOG.ok('Camera.start() resolved — waiting for first frame');
                    })
                    .catch(handleCameraStartupError);
            } else {
                startBtn.disabled = false;
                LOG.ok('Camera.start() called — waiting for first frame');
            }
        } catch (error) {
            handleCameraStartupError(error);
        }
    }));
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
            const scanPaused = !captureGateState.ok;
            statusText.textContent = scanPaused ? "SCAN PAUSED - ADJUST POSITION" : "DEEP BIOMETRIC SCAN ACTIVE";
            statusIndicator.classList.toggle('active', !scanPaused);

            if (scanPaused) {
                LOG.warn('Capture gate BLOCKED — frame skipped', captureGateState.reasons);
                lastGoodFrameTime = 0;
            }

            // Accumulate good scan time only while gate is open
            if (!scanPaused) {
                const now = Date.now();
                if (lastGoodFrameTime > 0) goodScanMs += now - lastGoodFrameTime;
                lastGoodFrameTime = now;
            }

            const scanProgress = Math.min(goodScanMs / SCAN_DURATION, 1);
            drawScanProgressBoundary(ctx, landmarks, scanProgress, scanPaused, meshColor);

            if (goodScanMs < SCAN_DURATION) {
                if (!scanPaused) {
                    pulseSamples.push({ t: goodScanMs, g: getForeheadGreen(landmarks, video) });
                    respirationSamples.push({ t: goodScanMs, y: landmarks[1].y });
                    detectBlink(landmarks);
                }
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
                // Require ≥4 regions at good quality before completing; allow up to SCAN_EXTENSION extra ms
                const goodRegionCount = REGIONS.filter(r => (bestRegionCategory[r.id] || 0) >= 2).length;
                if (goodRegionCount >= 4 || goodScanMs >= SCAN_DURATION + SCAN_EXTENSION) {
                    completeScan();
                } else {
                    // Extension phase: keep collecting data while region hints guide the user
                    if (!scanPaused) {
                        pulseSamples.push({ t: goodScanMs, g: getForeheadGreen(landmarks, video) });
                        respirationSamples.push({ t: goodScanMs, y: landmarks[1].y });
                        detectBlink(landmarks);
                    }
                    updateLiveRegions(landmarks, video);
                    timerText.textContent = '0.0s';
                    progressBarFill.style.width = '100%';
                }
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

            // Frames 5-12: build skin tone baseline + shine/colour advisory
            if (stabilizationFrames >= 5 && stabilizationFrames <= 12) {
                computeSkinBaseline(landmarks, video);
                if (checkShineLevel(landmarks, video) > 0.12) shineFrameCount++;
                if (shineFrameCount >= 3) shineAdvisory = true;
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
                            el.querySelector('.msp-state').textContent = CAPTURE_LABELS[0];
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

function computeRegionBbox(region, landmarks, video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const points = region.indices
        .map(idx => landmarks[idx])
        .filter(Boolean)
        .map(p => ({ x: p.x * vw, y: p.y * vh }));
    if (!points.length) return null;

    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    const rw = Math.max(2, maxX - minX), rh = Math.max(2, maxY - minY);
    const crop = region.crop || {};
    const padX = rw * (crop.padX ?? region.pad ?? 0.2);
    const padY = rh * (crop.padY ?? region.pad ?? 0.2);
    const cx = ((minX + maxX) / 2) + rw * (crop.offsetX ?? 0);
    const cy = ((minY + maxY) / 2) + rh * (crop.offsetY ?? 0);
    const faceW = Math.abs((landmarks[454]?.x ?? 0.8) - (landmarks[234]?.x ?? 0.2)) * vw;
    const faceH = Math.abs((landmarks[152]?.y ?? 0.85) - (landmarks[10]?.y ?? 0.15)) * vh;
    const tw = Math.max(rw + padX * 2, (crop.minFaceWidthRatio ?? 0) * faceW);
    const th = Math.max(rh + padY * 2, (crop.minFaceHeightRatio ?? 0) * faceH);

    const sx = Math.max(0, Math.round(cx - tw / 2));
    const sy = Math.max(0, Math.round(cy - th / 2));
    const sw = Math.max(2, Math.min(vw - sx, Math.round(tw)));
    const sh = Math.max(2, Math.min(vh - sy, Math.round(th)));

    return { sx, sy, sw, sh };
}

function drawRegionFallback(region, landmarks, video) {
    const bbox = computeRegionBbox(region, landmarks, video);
    if (!bbox) return;
    const { sx, sy, sw, sh } = bbox;
    offscreenCtx.drawImage(video, sx, sy, sw, sh, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
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

function drawScanProgressBoundary(ctx, landmarks, progress, isPaused, meshColor) {
    if (!ctx || !landmarks || scanStartTime === 0) return;

    const left = landmarks[234], right = landmarks[454], top = landmarks[10], chin = landmarks[152];
    if (!left || !right || !top || !chin) return;

    const minX = Math.min(left.x, right.x);
    const maxX = Math.max(left.x, right.x);
    const minY = Math.min(top.y, chin.y);
    const maxY = Math.max(top.y, chin.y);

    const cx = ((minX + maxX) / 2) * ctx.canvas.width;
    const cy = ((minY + maxY) / 2) * ctx.canvas.height;
    const rx = ((maxX - minX) / 2 + SCAN_PROGRESS_RING_GAP) * ctx.canvas.width;
    const ry = ((maxY - minY) / 2 + SCAN_PROGRESS_RING_GAP * 0.72) * ctx.canvas.height;

    if (!Number.isFinite(cx + cy + rx + ry) || rx < 20 || ry < 30) return;

    const pct = Math.max(0, Math.min(1, progress));
    const stroke = Math.max(4, Math.min(8, ctx.canvas.width * 0.008));
    const start = -Math.PI / 2;
    const end = start + (Math.PI * 2 * pct);
    const progressColor = isPaused ? '#ff4444' : meshColor;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowBlur = 14;
    ctx.shadowColor = isPaused ? 'rgba(255,68,68,0.35)' : 'rgba(236,97,14,0.45)';

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = stroke;
    ctx.stroke();

    if (pct > 0) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, start, end);
        ctx.strokeStyle = progressColor;
        ctx.lineWidth = stroke + 1;
        ctx.stroke();
    }

    // A compact numeric cue reduces ambiguity without covering the face.
    const label = isPaused ? `PAUSED ${Math.round(pct * 100)}%` : `${Math.round(pct * 100)}%`;
    const labelY = Math.max(22, cy - ry - 12);
    ctx.shadowBlur = 0;
    ctx.font = `700 ${Math.max(11, Math.min(16, ctx.canvas.width * 0.018))}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(label).width;
    const padX = 10;
    const boxH = 24;
    ctx.fillStyle = 'rgba(8,8,10,0.78)';
    ctx.strokeStyle = isPaused ? 'rgba(255,68,68,0.42)' : 'rgba(236,97,14,0.42)';
    ctx.lineWidth = 1;
    const boxX = cx - textWidth / 2 - padX;
    const boxY = labelY - boxH / 2;
    const boxW = textWidth + padX * 2;
    const boxR = 12;
    ctx.beginPath();
    ctx.moveTo(boxX + boxR, boxY);
    ctx.lineTo(boxX + boxW - boxR, boxY);
    ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + boxR);
    ctx.lineTo(boxX + boxW, boxY + boxH - boxR);
    ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - boxR, boxY + boxH);
    ctx.lineTo(boxX + boxR, boxY + boxH);
    ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - boxR);
    ctx.lineTo(boxX, boxY + boxR);
    ctx.quadraticCurveTo(boxX, boxY, boxX + boxR, boxY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isPaused ? '#ffcf66' : '#F5EDE6';
    ctx.fillText(label, cx, labelY + 0.5);
    ctx.restore();
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

// Region-specific hints shown during active scan when a region is stuck below good quality
const REGION_HINTS = {
    'live-Forehead':    'IMPROVING FOREHEAD DETAIL — KEEP HAIR AWAY',
    'live-Nose':        'IMPROVING NOSE DETAIL — REDUCE GLARE',
    'live-Left-Cheek':  'IMPROVING LEFT CHEEK SIDE — TURN SLIGHTLY TOWARD LIGHT',
    'live-Right-Cheek': 'IMPROVING RIGHT CHEEK SIDE — TURN SLIGHTLY TOWARD LIGHT',
    'live-Chin':        'IMPROVING CHIN DETAIL — LIFT SLIGHTLY',
    'live-Jawline':     'IMPROVING JAWLINE SIDES — KEEP LOWER FACE VISIBLE',
};

function getRegionHint() {
    if (scanStartTime === 0 || goodScanMs < 4000) return null;

    // Regions that haven't reached good quality and aren't locked yet
    const stuck = REGIONS.filter(r => {
        if (regionLocks[r.id]?.locked) return false;
        return (bestRegionCategory[r.id] || 0) < 2;
    });
    if (stuck.length === 0) return null;

    // Rotate through stuck regions every 3 seconds of good scan time
    const idx = Math.floor(goodScanMs / 3000) % stuck.length;
    return REGION_HINTS[stuck[idx].id] || null;
}

function computeSkinBaseline(landmarks, video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const top = landmarks[10], browL = landmarks[107];
    const tempL = landmarks[234], tempR = landmarks[454];
    const x  = Math.max(0, Math.round((tempL.x + (tempR.x - tempL.x) * 0.15) * vw));
    const y  = Math.max(0, Math.round(top.y * vh));
    const w  = Math.max(4, Math.round((tempR.x - tempL.x) * 0.70 * vw));
    const h  = Math.max(4, Math.round((browL.y - top.y) * 0.80 * vh));
    const cW = Math.min(w, 40), cH = Math.min(h, 40);
    offscreenCanvas.width = cW; offscreenCanvas.height = cH;
    offscreenCtx.drawImage(video, x, y, w, h, 0, 0, cW, cH);
    const d = offscreenCtx.getImageData(0, 0, cW, cH).data;
    let rS = 0, gS = 0, bS = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { rS += d[i]; gS += d[i + 1]; bS += d[i + 2]; n++; }
    if (n < 1) return;
    if (!skinBaseline) {
        skinBaseline = { r: rS / n, g: gS / n, b: bS / n };
    } else {
        skinBaseline.r = skinBaseline.r * 0.7 + (rS / n) * 0.3;
        skinBaseline.g = skinBaseline.g * 0.7 + (gS / n) * 0.3;
        skinBaseline.b = skinBaseline.b * 0.7 + (bS / n) * 0.3;
    }
    // Derive lighting colour warning from baseline
    if (skinBaseline.g / Math.max(1, skinBaseline.r) > 1.8)     lightingColourWarning = 'fluorescent';
    else if (skinBaseline.b / Math.max(1, skinBaseline.g) > 1.6) lightingColourWarning = 'cold-led';
    else                                                           lightingColourWarning = null;
}

function checkShineLevel(landmarks, video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return 0;
    const top = landmarks[10], browL = landmarks[107];
    const tempL = landmarks[234], tempR = landmarks[454];
    const x  = Math.max(0, Math.round((tempL.x + (tempR.x - tempL.x) * 0.15) * vw));
    const y  = Math.max(0, Math.round(top.y * vh));
    const w  = Math.max(4, Math.round((tempR.x - tempL.x) * 0.70 * vw));
    const h  = Math.max(4, Math.round((browL.y - top.y) * 0.80 * vh));
    const cW = Math.min(w, 30), cH = Math.min(h, 30);
    offscreenCanvas.width = cW; offscreenCanvas.height = cH;
    offscreenCtx.drawImage(video, x, y, w, h, 0, 0, cW, cH);
    const d = offscreenCtx.getImageData(0, 0, cW, cH).data;
    let glareCount = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
        const maxC = Math.max(d[i], d[i + 1], d[i + 2]);
        const minC = Math.min(d[i], d[i + 1], d[i + 2]);
        if (maxC / 255 > 0.90 && (maxC > 0 ? (maxC - minC) / maxC : 0) < 0.15) glareCount++;
        n++;
    }
    return n > 0 ? glareCount / n : 0;
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
    } else if (lightingColourWarning && scanStartTime === 0) {
        text  = 'HARSH LIGHTING — MOVE TO NATURAL OR WARM LIGHT';
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
    } else if (shineAdvisory && scanStartTime === 0) {
        text  = 'SKIN LOOKS VERY SHINY — BLOT FACE FOR BEST RESULTS';
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
            const hint = getRegionHint();
            if (hint) {
                text  = hint;
                color = '#00d2ff';
            } else {
                text  = 'SCANNING…';
                color = '#00d2ff';
            }
        } else {
            text  = 'HOLD STILL';
            color = '#00e676';
        }
    }

    instructionOverlay.textContent = text;
    instructionOverlay.style.color = color;
    instructionOverlay.classList.remove('hidden');
}

// Per-region scoring weights: [sharpness, glare, exposure, occlusion, stability, colorFidelity]
const REGION_WEIGHTS = {
    'live-Forehead':    [0.44, 0.26, 0.08, 0.06, 0.04, 0.12],
    'live-Nose':        [0.44, 0.28, 0.08, 0.04, 0.04, 0.12],
    'live-Left-Cheek':  [0.35, 0.18, 0.12, 0.08, 0.05, 0.22],
    'live-Right-Cheek': [0.35, 0.18, 0.12, 0.08, 0.05, 0.22],
    'live-Chin':        [0.38, 0.16, 0.10, 0.14, 0.06, 0.16],
    'live-Jawline':     [0.35, 0.14, 0.10, 0.20, 0.07, 0.14],
};
const WEIGHTS_DEFAULT = [0.40, 0.20, 0.10, 0.10, 0.05, 0.15];

// T-zone needs stricter sharpness (pore-level detail) and less motion tolerance
const SHARPNESS_NORM = {
    'live-Forehead': 20, 'live-Nose': 20,
    'live-Left-Cheek': 26, 'live-Right-Cheek': 26,
    'live-Chin': 26, 'live-Jawline': 26,
};
const STABILITY_NORM = {
    'live-Forehead': 16, 'live-Nose': 16,
    'live-Left-Cheek': 22, 'live-Right-Cheek': 22,
    'live-Chin': 22, 'live-Jawline': 22,
};
const CAPTURE_LABELS = ['FINDING', 'HOLD STEADY', 'CAPTURED', 'VERIFIED'];

function getRegionCaptureCategory(regionId) {
    const lock = regionLocks[regionId] || {};
    const buf = regionBuffers[regionId] || [];
    const best = buf.length > 0 ? buf[0].quality : 0;

    if (lock.locked) return 3;
    if (best >= 48) return 2;
    if (best > 0) return 1;
    return 0;
}

function getRegionCaptureLabel(regionId) {
    return CAPTURE_LABELS[getRegionCaptureCategory(regionId)] || CAPTURE_LABELS[0];
}

function getRegionQualityGuidance(region, quality) {
    if (!quality) return 'Finding region';
    if (quality.wbWarning === 'fluorescent' || quality.wbWarning === 'cold-led') return 'Needs softer light';
    if (quality.wbWarning === 'warm-incandescent') return 'Needs neutral light';
    if (quality.score >= (region.lockThreshold || 80)) return 'Verifying';
    if (quality.score >= 58) return 'Captured';
    return 'Hold steady';
}

function analyzeSampleQuality(regionId, imgData, width, height, nowTs) {
    const data = imgData;
    const rowStride = width * 4;

    let lumSum = 0;
    let gradSum = 0;
    let clipLowCount = 0;   // lum 0-5 (crushed black)
    let clipHighCount = 0;  // lum 250-255 (blown highlight)
    let darkCount = 0;      // lum < 28 (occlusion / shadow)
    let glareCount = 0;     // HSV specular: V>0.90 && S<0.15
    let rSum = 0, gSum = 0, bSum = 0;
    let rSqSum = 0;          // for red channel variance (color fidelity)
    let rHighCount = 0;      // red channel saturation >= 248 (blows redness signal)
    let motionDiffSum = 0;

    const prev = previousSamples[regionId];
    const hasPrev = prev && prev.data && prev.w === width && prev.h === height;

    const GRID = 4;
    const cellW = width / GRID, cellH = height / GRID;
    const cellLumSum = new Float32Array(GRID * GRID);
    const cellCounts = new Int32Array(GRID * GRID);

    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const i = (y * width + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = (0.299 * r) + (0.587 * g) + (0.114 * b);
            const lumX = (0.299 * data[i + 4]) + (0.587 * data[i + 5]) + (0.114 * data[i + 6]);
            const lumY = (0.299 * data[i + rowStride]) + (0.587 * data[i + rowStride + 1]) + (0.114 * data[i + rowStride + 2]);

            lumSum += lum;
            gradSum += Math.abs(lum - lumX) + Math.abs(lum - lumY);
            rSum += r; gSum += g; bSum += b;
            rSqSum += r * r;

            if (lum <= 5)   clipLowCount++;
            if (lum >= 250) clipHighCount++;
            if (lum < 28)   darkCount++;
            if (r >= 248)   rHighCount++;

            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const V = maxC / 255;
            const S = maxC > 0 ? (maxC - minC) / maxC : 0;
            if (V > 0.90 && S < 0.15) glareCount++;

            const cx = Math.min(Math.floor(x / cellW), GRID - 1);
            const cy = Math.min(Math.floor(y / cellH), GRID - 1);
            cellLumSum[cy * GRID + cx] += lum;
            cellCounts[cy * GRID + cx]++;

            if (hasPrev) {
                const prevLum = (0.299 * prev.data[i]) + (0.587 * prev.data[i + 1]) + (0.114 * prev.data[i + 2]);
                motionDiffSum += Math.abs(lum - prevLum);
            }
        }
    }

    previousSamples[regionId] = { data: new Uint8ClampedArray(data), w: width, h: height };

    const validPixels = (width - 1) * (height - 1);
    const gradMean  = gradSum  / Math.max(1, validPixels * 2);
    const glareFrac = glareCount / Math.max(1, validPixels);
    const darkFrac  = darkCount  / Math.max(1, validPixels);
    const motionMean = hasPrev ? (motionDiffSum / Math.max(1, validPixels)) : 0;
    const meanR = rSum / Math.max(1, validPixels);
    const meanG = gSum / Math.max(1, validPixels);
    const meanB = bSum / Math.max(1, validPixels);

    // ── Sharpness: per-region normaliser — T-zone requires pore-level crispness ──
    const sharpNorm = SHARPNESS_NORM[regionId] || 26;
    const sharpnessScore = clamp01(gradMean / sharpNorm);

    // ── Glare: HSV specular highlights ──
    const glareScore = clamp01(1 - (glareFrac / 0.07));

    // ── Exposure: clipping + 4×4 uniformity + red channel headroom ──
    const clipFrac = (clipLowCount + clipHighCount) / Math.max(1, validPixels);
    const clipPenalty = clamp01(clipFrac / 0.08);
    const cellMeans = cellLumSum.map((s, idx) => s / Math.max(1, cellCounts[idx]));
    const cellMeanAvg = cellMeans.reduce((a, b) => a + b, 0) / cellMeans.length;
    const cellVariance = cellMeans.reduce((s, v) => s + (v - cellMeanAvg) ** 2, 0) / cellMeans.length;
    const uniformityPenalty = clamp01(Math.sqrt(cellVariance) / 60);
    const redHeadroomPenalty = clamp01((rHighCount / Math.max(1, validPixels)) / 0.10);
    const exposureScore = clamp01(1 - (clipPenalty * 0.5 + uniformityPenalty * 0.3 + redHeadroomPenalty * 0.2));

    // ── Occlusion ──
    const occlusionScore = clamp01(1 - (darkFrac / 0.35));

    // ── Stability: per-region normaliser — T-zone tolerates less motion ──
    const stabilityNorm = STABILITY_NORM[regionId] || 22;
    const stabilityScore = clamp01(1 - (motionMean / stabilityNorm));

    // ── Color fidelity: replaces luminance contrast — red-channel acne signal preservation ──
    const redVariance = Math.max(0, rSqSum / Math.max(1, validPixels) - meanR * meanR);
    const redVarScore   = clamp01(Math.sqrt(redVariance) / 30);       // color variation in patch
    const rgDiffScore   = clamp01((meanR - meanG) / 20 + 0.5);        // warm skin signal; WB issues lower this
    const redRangeScore = clamp01(1 - Math.abs(meanR - 128) / 128);   // channel not blown or crushed

    let colorFidelityScore;
    if (skinBaseline && skinBaseline.r > 0) {
        // Relative to this person's baseline — works for all skin tones
        const baselineRatio = meanR / skinBaseline.r;
        const baselineScore = clamp01(1 - Math.abs(baselineRatio - 1.0) / 0.5);
        colorFidelityScore = redVarScore * 0.40 + baselineScore * 0.35 + rgDiffScore * 0.25;
    } else {
        colorFidelityScore = redVarScore * 0.50 + rgDiffScore * 0.30 + redRangeScore * 0.20;
    }

    const W = REGION_WEIGHTS[regionId] || WEIGHTS_DEFAULT;
    const qualityScore =
        sharpnessScore      * W[0] +
        glareScore          * W[1] +
        exposureScore       * W[2] +
        occlusionScore      * W[3] +
        stabilityScore      * W[4] +
        colorFidelityScore  * W[5];

    // WB sanity — used by instruction overlay and returned for logging
    let wbWarning = null;
    if (meanG / Math.max(1, meanR) > 1.8)       wbWarning = 'fluorescent';
    else if (meanB / Math.max(1, meanG) > 1.6)  wbWarning = 'cold-led';
    else if (meanR / Math.max(1, meanB) > 2.5)  wbWarning = 'warm-incandescent';

    return {
        score: Math.round(qualityScore * 100),
        sharpnessRaw: gradMean,
        wbWarning
    };
}

function updateLiveRegions(landmarks, video) {
    REGIONS.forEach(r => {
        const liveCanvas = document.getElementById(r.id);
        if (!liveCanvas) return;

        if (!regionLocks[r.id]) regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
        const lockState = regionLocks[r.id];
        const tile = liveCanvas.parentElement;
        const indicator = tile.querySelector('.refining-indicator');

        if (lockState.locked) {
            tile.dataset.state = '3';
            if (indicator) {
                indicator.textContent = 'VERIFIED';
            }
            return;
        }

        // Native bbox crop — real resolution, real aspect ratio, zero distortion
        const bbox = computeRegionBbox(r, landmarks, video);
        if (!bbox) return;
        const { sx, sy, sw, sh } = bbox;

        if (offscreenCanvas.width !== sw || offscreenCanvas.height !== sh) {
            offscreenCanvas.width = sw;
            offscreenCanvas.height = sh;
        }
        offscreenCtx.clearRect(0, 0, sw, sh);
        offscreenCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

        // Single getImageData: used for both quality scoring and buffer storage
        const nativeData = offscreenCtx.getImageData(0, 0, sw, sh);
        const nowTs = Date.now();
        const quality = analyzeSampleQuality(r.id, nativeData.data, sw, sh, nowTs);

        const qualityMultiplier = r.quality || 1.0;

        // Resize live canvas to match native crop (reset buffer if size changed)
        if (liveCanvas.width !== sw || liveCanvas.height !== sh) {
            liveCanvas.width = sw;
            liveCanvas.height = sh;
            regionBuffers[r.id] = [];
        }
        const liveCtx = liveCanvas.getContext('2d', { willReadFrequently: true });

        const buffer = regionBuffers[r.id];
        const gateBlocked = !captureGateState.ok;
        if (gateBlocked) {
            tile.dataset.state = String(getRegionCaptureCategory(r.id));
            if (indicator) {
                indicator.textContent = captureGateState.reasons[0] || getRegionCaptureLabel(r.id);
            }
            return;
        }

        // Always show current frame in live preview tile
        liveCtx.putImageData(nativeData, 0, 0);

        const effectiveScore = quality.score / qualityMultiplier;
        if (buffer.length < MAX_BUFFER_SIZE || effectiveScore > buffer[buffer.length - 1].score) {
            buffer.push({ score: effectiveScore, quality: quality.score, data: nativeData, ts: nowTs });
            buffer.sort((a, b) => b.score - a.score);
            if (buffer.length > MAX_BUFFER_SIZE) buffer.pop();

            if (quality.score >= (r.lockThreshold || 80) && buffer.length >= 3) {
                lockState.locked = true;
                lockState.quality = quality.score;
                lockState.ts = nowTs;
                LOG.ok(`Region LOCKED: ${r.name}`, { quality: quality.score, threshold: r.lockThreshold, framesInBuffer: buffer.length });
                const lockedCount = REGIONS.filter(reg => regionLocks[reg.id]?.locked).length;
                LOG.info(`Locked regions: ${lockedCount} / ${REGIONS.length}`);
            }
        }

        const captureCategory = getRegionCaptureCategory(r.id);
        tile.dataset.state = String(captureCategory);

        if (indicator) {
            if (lockState.locked) {
                indicator.textContent = 'VERIFIED';
            } else {
                indicator.textContent = getRegionQualityGuidance(r, quality);
            }
        }
    });

    // Update regions-ready counter (desktop only — hidden on mobile via CSS)
    if (regionReadyCount) {
        const locked = REGIONS.filter(r => getRegionCaptureCategory(r.id) === 3).length;
        const captured = REGIONS.filter(r => getRegionCaptureCategory(r.id) >= 2).length;
        const total  = REGIONS.length;
        const focusRegion = REGIONS.find(r => getRegionCaptureCategory(r.id) < 2);
        regionReadyCount.classList.remove('hidden', 'all-locked');
        if (locked === 0) {
            regionReadyCount.textContent = captured > 0
                ? `${captured} of ${total} regions captured - hold steady`
                : 'Building region checklist - hold steady';
            regionReadyCount.style.color = '';
        } else if (locked < total - 1) {
            regionReadyCount.textContent = `${locked} of ${total} regions verified - focus on ${focusRegion?.name || 'remaining regions'}`;
            regionReadyCount.style.color = '#F0A030';
        } else if (locked === total - 1) {
            regionReadyCount.textContent = `${locked} of ${total} regions verified - almost done`;
            regionReadyCount.style.color = '#a0e080';
        } else {
            regionReadyCount.textContent = `ALL ${total} REGIONS VERIFIED`;
            regionReadyCount.style.color = '#00e676';
            regionReadyCount.classList.add('all-locked');
        }
    }

    // Update mobile progress list (only meaningful when visible)
    if (mobileScanProgress && !mobileScanProgress.classList.contains('hidden')) {
        REGIONS.forEach(r => {
            const cat = getRegionCaptureCategory(r.id);

            // Category can only go up within a scan
            if (cat > (bestRegionCategory[r.id] || 0)) bestRegionCategory[r.id] = cat;
            const displayCat = bestRegionCategory[r.id] || 0;

            const item = mobileScanProgress.querySelector(`[data-region="${r.id}"]`);
            if (!item) return;
            if (parseInt(item.getAttribute('data-state')) !== displayCat) {
                item.setAttribute('data-state', displayCat);
                item.querySelector('.msp-state').textContent = CAPTURE_LABELS[displayCat];
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
    document.body.classList.remove('scan-active');
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
    document.body.classList.add('region-confirm-active');
    regionConfirmationView.classList.remove('hidden');
    LOG.ok('Region confirmation view shown — awaiting user confirmation');
}

function populateRegionConfirmation() {
    regionImagesGrid.innerHTML = '';
    REGIONS.forEach(r => {
        const buf  = regionBuffers[r.id] || [];

        const wrapper = document.createElement('div');
        wrapper.className = `confirm-region-card confirm-${r.id.replace('live-', '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

        const label = document.createElement('div');
        label.className = 'confirm-region-name';
        label.textContent = r.name.toUpperCase();

        const selector = document.createElement('label');
        selector.className = 'confirm-region-selector';
        selector.setAttribute('aria-label', `Include ${r.name} in confirmed regions`);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.region = r.id;
        checkbox.addEventListener('change', () => {
            wrapper.classList.toggle('is-excluded', !checkbox.checked);
        });
        const selectorMark = document.createElement('span');
        selectorMark.setAttribute('aria-hidden', 'true');
        selector.appendChild(checkbox);
        selector.appendChild(selectorMark);

        const imageWrap = document.createElement('div');
        imageWrap.className = 'confirm-region-image-wrap';

        const cnv = document.createElement('canvas');
        cnv.className = 'confirm-region-canvas';

        if (buf.length > 0 && buf[0].data) {
            // Render at native resolution — ImageData already carries .width and .height
            const imgData = buf[0].data;
            cnv.width  = imgData.width;
            cnv.height = imgData.height;
            cnv.getContext('2d').putImageData(imgData, 0, 0);
        } else {
            cnv.width  = 200;
            cnv.height = 150;
            const ctx = cnv.getContext('2d');
            ctx.fillStyle = '#0d0d1a';
            ctx.fillRect(0, 0, cnv.width, cnv.height);
            ctx.fillStyle = '#555';
            ctx.font = 'bold 13px Montserrat,sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('NO DATA', cnv.width / 2, cnv.height / 2);
        }

        imageWrap.appendChild(cnv);
        imageWrap.appendChild(selector);
        wrapper.appendChild(label);
        wrapper.appendChild(imageWrap);
        regionImagesGrid.appendChild(wrapper);
    });
}

const REGION_PAYLOAD_KEYS = {
    'live-Forehead': 'forehead',
    'live-Nose': 'nose',
    'live-Left-Cheek': 'left_cheek',
    'live-Right-Cheek': 'right_cheek',
    'live-Chin': 'chin',
    'live-Jawline': 'jawline'
};

function metricClamp(v) {
    return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function metricRound(v) {
    return Math.round(metricClamp(v) * 1000) / 1000;
}

function getConfirmedRegionIds() {
    const boxes = regionImagesGrid.querySelectorAll('.confirm-region-selector input[type="checkbox"]');
    if (!boxes.length) return new Set(REGIONS.map(r => r.id));
    return new Set([...boxes].filter(box => box.checked).map(box => box.dataset.region));
}

function extractSkinSignalMetrics(region, imgData, lockState) {
    const data = imgData?.data;
    const width = imgData?.width || 0;
    const height = imgData?.height || 0;
    if (!data || width < 2 || height < 2) return null;

    let lumSum = 0, lumSqSum = 0, gradSum = 0;
    let rSum = 0, gSum = 0, bSum = 0;
    let redCount = 0, redBrightCount = 0, glareCount = 0, darkSpotCount = 0;
    let leftLumSum = 0, rightLumSum = 0, leftCount = 0, rightCount = 0;
    const valid = (width - 1) * (height - 1);

    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const i = (y * width + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const lumX = 0.299 * data[i + 4] + 0.587 * data[i + 5] + 0.114 * data[i + 6];
            const rowNext = i + width * 4;
            const lumY = 0.299 * data[rowNext] + 0.587 * data[rowNext + 1] + 0.114 * data[rowNext + 2];

            lumSum += lum;
            lumSqSum += lum * lum;
            gradSum += Math.abs(lum - lumX) + Math.abs(lum - lumY);
            rSum += r; gSum += g; bSum += b;

            const redExcess = r - ((g + b) / 2);
            if (redExcess > 22 && r > 65) redCount++;
            if (redExcess > 28 && r > 120 && g > 55) redBrightCount++;

            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const v = maxC / 255;
            const s = maxC > 0 ? (maxC - minC) / maxC : 0;
            if (v > 0.90 && s < 0.16) glareCount++;

            if (x < width / 2) { leftLumSum += lum; leftCount++; }
            else { rightLumSum += lum; rightCount++; }
        }
    }

    const meanLum = lumSum / Math.max(1, valid);
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const i = (y * width + x) * 4;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < meanLum - 24) darkSpotCount++;
        }
    }

    const lumStd = Math.sqrt(Math.max(0, lumSqSum / Math.max(1, valid) - meanLum * meanLum));
    const gradMean = gradSum / Math.max(1, valid * 2);
    const redFrac = redCount / Math.max(1, valid);
    const redBrightFrac = redBrightCount / Math.max(1, valid);
    const glareFrac = glareCount / Math.max(1, valid);
    const darkFrac = darkSpotCount / Math.max(1, valid);
    const leftMean = leftLumSum / Math.max(1, leftCount);
    const rightMean = rightLumSum / Math.max(1, rightCount);

    const texture = metricClamp((gradMean / 30) * 0.58 + (lumStd / 58) * 0.42);
    const redness = metricClamp(redFrac / 0.14);
    const shine = metricClamp(glareFrac / 0.08);
    const pigmentation = metricClamp(darkFrac / 0.20);
    const toneVariance = metricClamp(lumStd / 62);
    const toneAsymmetry = metricClamp(Math.abs(leftMean - rightMean) / 58);
    const hydration = metricClamp(1 - (texture * 0.34 + pigmentation * 0.18 + shine * 0.16));
    const poreTexture = metricClamp((gradMean / 34) * 0.72 + shine * 0.18 + texture * 0.10);
    const fineLines = metricClamp((gradMean / 42) * 0.70 + (lumStd / 70) * 0.30);
    const acneRedness = metricClamp(redness * 0.70 + texture * 0.18 + shine * 0.12);

    const key = REGION_PAYLOAD_KEYS[region.id];
    const metrics = {
        _meta: {
            selected: true,
            source: 'client_image_proxy',
            metrics_version: 'visible-signal-v1',
            quality: Math.round(lockState?.quality || regionBuffers[region.id]?.[0]?.quality || 0),
            locked: !!lockState?.locked,
            crop_width: width,
            crop_height: height
        },
        erythema_index: metricRound(redness),
        texture_variance: metricRound(texture),
        hydration_proxy: metricRound(hydration)
    };

    if (['forehead', 'nose'].includes(key)) {
        metrics.gloss_reflectance_score = metricRound(shine);
        metrics.pore_diameter_variance = metricRound(poreTexture);
        metrics.comedone_density = metricRound(metricClamp((poreTexture * 0.55) + (shine * 0.30) + (darkFrac / 0.24) * 0.15));
    }
    if (['left_cheek', 'right_cheek'].includes(key)) {
        metrics.pih_density = metricRound(pigmentation);
        metrics.hyperpigmented_lesion_count = metricRound(metricClamp(darkFrac / 0.12));
        metrics.melanin_variance_score = metricRound(toneVariance);
        metrics.tone_asymmetry_score = metricRound(toneAsymmetry);
        metrics.papule_density = metricRound(acneRedness);
    }
    if (key === 'chin' || key === 'jawline') {
        metrics.papule_density = metricRound(acneRedness);
        metrics.pustule_density = metricRound(metricClamp(redBrightFrac / 0.08));
        metrics.comedone_density = metricRound(metricClamp((poreTexture * 0.45) + (darkFrac / 0.20) * 0.25));
    }
    if (key === 'forehead' || key === 'jawline') {
        metrics.wrinkle_depth_index = metricRound(fineLines);
        metrics.fine_line_density = metricRound(fineLines);
    }
    if (key === 'jawline') {
        metrics.sagging_index = metricRound(metricClamp(toneAsymmetry * 0.45 + texture * 0.22));
        metrics.elasticity_proxy = metricRound(metricClamp(1 - (texture * 0.34 + toneAsymmetry * 0.26)));
    }

    return metrics;
}

function buildVerifiedRegionPayload() {
    const selectedIds = getConfirmedRegionIds();
    const regions = {};
    const region_meta = {};

    REGIONS.forEach(region => {
        const key = REGION_PAYLOAD_KEYS[region.id];
        const selected = selectedIds.has(region.id);
        const lockState = regionLocks[region.id] || {};
        const best = regionBuffers[region.id]?.[0];

        region_meta[key] = {
            selected,
            locked: !!lockState.locked,
            quality: Math.round(lockState.quality || best?.quality || 0),
            frames_buffered: regionBuffers[region.id]?.length || 0
        };

        if (!selected || !best?.data) return;
        const metrics = extractSkinSignalMetrics(region, best.data, lockState);
        if (metrics) regions[key] = metrics;
    });

    return { regions, region_meta };
}

async function proceedToAnalysis() {
    LOG.section('proceedToAnalysis() — user confirmed regions, computing biometrics & posting to backend');

    // faceImageBase64 was captured at stabilization and stored
    const faceImageBase64 = _pendingFaceImageBase64;

    document.body.classList.remove('region-confirm-active');
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

    const verifiedPayload = buildVerifiedRegionPayload();
    const selectedRegionCount = Object.values(verifiedPayload.region_meta).filter(r => r.selected).length;
    if (selectedRegionCount === 0) {
        LOG.warn('No regions selected at confirmation; backend will return low-confidence result');
    }

    const payload = {
        regions:           verifiedPayload.regions,
        region_meta:       verifiedPayload.region_meta,
        global:            { environment_type: "urban" },
        biometrics:        { bpm, respiration: resp, blinkRate: blinks },
        face_image_base64: faceImageBase64
    };

    LOG.group('FULL PAYLOAD BEING SENT TO POST /analyze-face', () => {
        LOG.info('regions (keys present)', Object.keys(payload.regions));
        LOG.info('global', payload.global);
        LOG.info('biometrics (real data)', payload.biometrics);
        LOG.info('region_meta', payload.region_meta);
        LOG.info('face_image_base64 source', faceImageBase64 ? 'stabilization snapshot' : 'none');
        LOG.info('regions source', 'selected verified region crops → visible-signal proxy metrics');
        LOG.warn('biometrics are displayed separately; skin scoring uses visible region signals only');
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
            LOG.info('data_source', result.data_source);
            if (result.analysis_warnings?.length) LOG.warn('analysis_warnings', result.analysis_warnings);
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

    const overall = count > 0 ? Math.round(total / count) : null;
    const hero = document.createElement('div');
    hero.className = 'wellness-hero';
    hero.style.cssText = 'grid-column:1/-1;background:rgba(236,97,14,0.07);border:1px solid rgba(236,97,14,0.2);';
    hero.innerHTML = `
        <h1 style="font-size:4rem;line-height:1;margin-bottom:8px;color:#F5EDE6;">${overall ?? '--'}</h1>
        <p style="font-size:0.72rem;font-weight:600;letter-spacing:0.06em;color:#7A6055;text-transform:uppercase;">Overall Skin Signal Index</p>
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
        <h3>Skin Signal Summary</h3>
        <p>Confidence: <strong>${data.confidence ?? '--'}%</strong></p>
        <p>Estimated Age: <strong>${estimatedAge ?? '--'}</strong></p>
        <p>Profile: <strong>${demographics.age ?? '--'} / ${demographics.gender ?? '--'}</strong></p>
        <p>Finding: <strong style="color:#EC610E;">${summary.primary_finding || 'Maintenance & Prevention'}</strong></p>
        <p style="font-size:0.78rem;color:#7A6055;margin-top:8px;">Based on selected region crops and visible skin-signal proxies. Not a diagnosis.</p>
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
    document.body.classList.remove('region-confirm-active');
    if (regionReadyCount) { regionReadyCount.classList.add('hidden'); regionReadyCount.classList.remove('all-locked'); regionReadyCount.textContent = 'Building region checklist'; regionReadyCount.style.color = ''; }
    if (instructionOverlay) instructionOverlay.classList.add('hidden');
    if (mobileScanProgress) {
        mobileScanProgress.classList.add('hidden');
        mobileScanProgress.querySelectorAll('.msp-item').forEach(el => {
            el.setAttribute('data-state', '0');
            el.querySelector('.msp-state').textContent = CAPTURE_LABELS[0];
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
    lightingColourWarning = null;
    shineAdvisory = false;
    shineFrameCount = 0;
    coveringDetected = null;
    skinBaseline = null;
    document.body.classList.remove('scan-active');
    goodScanMs = 0;
    lastGoodFrameTime = 0;
    pulseSamples = [];
    respirationSamples = [];
    blinkCount = 0;

    // Reset visible scan/analysis UI state so next run starts clean.
    if (setupInstruction) setupInstruction.textContent = DEFAULT_SETUP_INSTRUCTION;
    startBtn.textContent = DEFAULT_START_BUTTON_TEXT;
    startBtn.disabled = false;
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
        if (tile) tile.dataset.state = '0';
        const indicator = tile?.querySelector('.refining-indicator');
        if (indicator) {
            indicator.textContent = 'FINDING';
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
