// INITIALIZE GLOBALS
let faceMesh, camera;

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
    }
];

/* ---------------- INITIALIZATION ---------------- */

function initFaceMesh() {
    const FaceMeshConstructor = window.FaceMesh || (window.faceMesh ? window.faceMesh.FaceMesh : null);
    if (!FaceMeshConstructor) {
        console.error("MediaPipe FaceMesh not loaded from CDN.");
        return;
    }

    faceMesh = new FaceMeshConstructor({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    faceMesh.onResults(onResults);
}

function startScanner() {
    setupView.classList.add('hidden');
    scannerView.classList.remove('hidden');

    if (!faceMesh) initFaceMesh();

    const CameraConstructor = window.Camera;
    if (!CameraConstructor) {
        console.error("MediaPipe Camera utility not loaded.");
        alert("Camera initialization failed. Please refresh.");
        return;
    }

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
}

/* ---------------- CORE SCAN LOOP ---------------- */

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
        
        // DRAW MESH
        ctx.save();
        if (window.drawConnectors) {
            drawConnectors(ctx, landmarks, window.FACEMESH_TESSELATION, {color: 'rgba(255,255,255,0.25)', lineWidth: 0.5});
            drawConnectors(ctx, landmarks, window.FACEMESH_CONTOURS, {color: '#00d2ff', lineWidth: 1.2});
        }
        ctx.restore();

        // SCAN LOGIC
        if (scanStartTime > 0) {
            statusText.textContent = "DEEP BIOMETRIC SCAN ACTIVE";
            statusIndicator.classList.add('active');
            liveRegionRow.classList.remove('hidden');
            captureGateState = computeCaptureGate(landmarks, video);

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
                
                timerText.textContent = `${((SCAN_DURATION - elapsed) / 1000).toFixed(1)}s`;
                progressBarFill.style.width = `${(elapsed / SCAN_DURATION) * 100}%`;
            } else {
                completeScan();
            }
        } else {
            stabilizationFrames++;
            statusText.textContent = `STABILIZING... ${Math.round((stabilizationFrames/15)*100)}%`;
            if (stabilizationFrames >= 15) {
                scanStartTime = Date.now();
                analysisOverlay.classList.remove('hidden');
                REGIONS.forEach(r => {
                    regionBuffers[r.id] = [];
                    regionLocks[r.id] = { locked: false, quality: 0, ts: 0 };
                    previousSamples[r.id] = null;
                });
            }
        }
    } else {
        lostFrames++;
        if (lostFrames > 10) {
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

async function completeScan() {
    isAnalyzing = true;
    const faceImageBase64 = captureCurrentFaceImageBase64();
    scannerView.classList.add('hidden');
    liveRegionRow.classList.add('hidden');
    // Simplified 2-step UX: scan -> analysis/result.
    await proceedToAnalysis(faceImageBase64);
}

async function proceedToAnalysis(faceImageBase64 = null) {
    regionConfirmationView.classList.add('hidden');
    analysisView.classList.remove('hidden');
    const bpm = calculateBPM(pulseSamples), resp = calculateRespiration(respirationSamples), blinks = Math.round((blinkCount / (SCAN_DURATION / 1000)) * 60);
    previewBPM.textContent = bpm; previewResp.textContent = resp; previewBlink.textContent = blinks;

    let deepProgress = 0;
    const deepTimer = setInterval(() => { deepProgress += 2; deepProgressFill.style.width = `${Math.min(deepProgress, 98)}%`; }, 100);

    try {
        const response = await fetch('/analyze-face', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                regions: { forehead: { gloss_reflectance_score: 0.2, wrinkle_depth_index: 0.1 }, nose: { gloss_reflectance_score: 0.6, pore_diameter_variance: 0.5 }, chin: { erythema_index: 0.3 } },
                global: { age: 30, gender: "female", environment_type: "urban" },
                biometrics: { bpm, respiration: resp, blinkRate: blinks },
                face_image_base64: faceImageBase64
            })
        });
        clearInterval(deepTimer);
        if (!response.ok) {
            let errorMessage = `Request failed (${response.status})`;
            try {
                const errorPayload = await response.json();
                errorMessage = errorPayload.message || errorMessage;
            } catch (_) {
                // Keep fallback message when error response is not JSON.
            }
            throw new Error(errorMessage);
        }
        const result = await response.json();
        setTimeout(() => { analysisView.classList.add('hidden'); showResults(result, { bpm, resp, blinks }, faceImageBase64); }, 1000);
    } catch (err) {
        clearInterval(deepTimer);
        alert(`Analysis Error: ${err.message}`);
        resetScanner();
    }
}

function calculateBPM(samples) {
    if (samples.length < 100) return 72;
    const signal = samples.map(s => s.g);
    const filtered = detrend(signal, 5);
    const smoothed = movingAverage(filtered, 3);
    let peaks = 0;
    const threshold = getStandardDeviation(smoothed) * 0.8;
    for (let i = 2; i < smoothed.length - 2; i++) if (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1] && smoothed[i] > threshold) { peaks++; i += 5; }
    const bpm = Math.round((peaks / ((samples[samples.length - 1].t - samples[0].t) / 1000)) * 60);
    return Math.min(Math.max(bpm, 55), 110);
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
    if (samples.length < 50) return 16;
    const d = detrend(samples.map(s => s.y), 20);
    let c = 0;
    for (let i = 1; i < d.length; i++) if ((d[i-1] < 0 && d[i] >= 0) || (d[i-1] > 0 && d[i] <= 0)) c++;
    return Math.min(Math.max(Math.round((c / 2 / (SCAN_DURATION / 1000)) * 60), 12), 20);
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

function showResults(data, vitals, submittedFaceImageBase64 = null) {
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
    hero.style.gridColumn = "1 / -1";
    hero.style.background = 'rgba(255,255,255,0.04)';
    hero.style.border = '1px solid rgba(255,255,255,0.1)';
    hero.innerHTML = `
        <h1 style="font-size: 4.2rem; line-height: 1; margin-bottom: 8px;">${overall}</h1>
        <p style="letter-spacing: 2px; font-size: 0.75rem; color: #aaa;">OVERALL WELLNESS INDEX</p>
    `;
    resultsGrid.appendChild(hero);

    const vitalsCard = document.createElement('div');
    vitalsCard.className = 'result-card';
    vitalsCard.style.background = 'rgba(255,255,255,0.04)';
    vitalsCard.style.border = '1px solid rgba(255,255,255,0.1)';
    vitalsCard.innerHTML = `
        <h3 style="margin-bottom: 12px; font-size: 0.9rem; letter-spacing: 1px;">Scan Biometrics</h3>
        <p style="margin: 4px 0;">BPM: <strong>${vitals.bpm}</strong></p>
        <p style="margin: 4px 0;">Respiration: <strong>${vitals.resp}</strong> br/m</p>
        <p style="margin: 4px 0;">Blink Rate: <strong>${vitals.blinks}</strong> blinks/m</p>
    `;
    resultsGrid.appendChild(vitalsCard);

    const metaCard = document.createElement('div');
    metaCard.className = 'result-card';
    metaCard.style.background = 'rgba(255,255,255,0.04)';
    metaCard.style.border = '1px solid rgba(255,255,255,0.1)';
    const demographics = data.demographics || {};
    const summary = data.dermatology_summary || {};
    const estimatedAge = data.age_estimation?.estimated_age;
    metaCard.innerHTML = `
        <h3 style="margin-bottom: 12px; font-size: 0.9rem; letter-spacing: 1px;">Clinical Summary</h3>
        <p style="margin: 4px 0;">Confidence: <strong>${data.confidence ?? '--'}%</strong></p>
        <p style="margin: 4px 0;">Estimated Age (HF): <strong>${estimatedAge ?? '--'}</strong></p>
        <p style="margin: 4px 0;">Age/Gender: <strong>${demographics.age ?? '--'} / ${demographics.gender ?? '--'}</strong></p>
        <p style="margin: 4px 0;">Finding: <strong>${summary.primary_finding || 'NA'}</strong></p>
    `;
    resultsGrid.appendChild(metaCard);

    if (submittedFaceImageBase64) {
        const imageCard = document.createElement('div');
        imageCard.className = 'result-card';
        imageCard.style.background = 'rgba(255,255,255,0.04)';
        imageCard.style.border = '1px solid rgba(255,255,255,0.1)';
        imageCard.innerHTML = `
            <h3 style="margin-bottom: 12px; font-size: 0.9rem; letter-spacing: 1px;">Image Sent To HF</h3>
            <img
                src="${submittedFaceImageBase64}"
                alt="Face frame sent to Hugging Face"
                style="width: 100%; max-height: 260px; object-fit: contain; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15); background: #000;"
            />
        `;
        resultsGrid.appendChild(imageCard);
    }

    Object.entries(data.pillars || {}).forEach(([pillarName, pillar]) => {
        if (!pillar) return;
        const card = document.createElement('div');
        card.className = 'result-card';
        card.style.background = 'rgba(255,255,255,0.03)';
        card.style.border = '1px solid rgba(255,255,255,0.08)';
        card.innerHTML = `
            <h3 style="margin-bottom: 8px; font-size: 0.85rem;">${pillarName.replaceAll('_', ' ')}</h3>
            <p style="margin: 3px 0;">Score: <strong>${pillar.score}</strong></p>
            <p style="margin: 3px 0;">State: <strong>${pillar.state}</strong></p>
            <p style="margin: 3px 0;">Driver Region: <strong>${pillar.driver_region || 'NA'}</strong></p>
            <p style="margin: 8px 0 0; color: #b9b9b9; font-size: 0.8rem;">${pillar.insight || ''}</p>
        `;
        resultsGrid.appendChild(card);
    });

    const foot = document.createElement('div');
    foot.style.gridColumn = "1 / -1";
    foot.appendChild(resetBtn);
    resultsGrid.appendChild(foot);
}

function resetScanner() {
    isAnalyzing = false;
    resultsSection.classList.add('hidden'); analysisView.classList.add('hidden'); regionConfirmationView.classList.add('hidden');
    setupView.classList.remove('hidden'); analysisOverlay.classList.add('hidden'); liveRegionRow.classList.add('hidden');
    scanStartTime = 0;
    stabilizationFrames = 0;
    lostFrames = 0;
    lastLandmarks = null;
    eyeClosed = false;
    captureGateState = { ok: false, reasons: [] };
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
confirmRegionsBtn.addEventListener('click', proceedToAnalysis);
retryScanBtn.addEventListener('click', resetScanner);

// INIT ON LOAD
window.addEventListener('DOMContentLoaded', () => {
    initFaceMesh();
});
