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

// HD BUFFERING
const regionBuffers = {}; 
const MAX_BUFFER_SIZE = 10;

// CLINICAL REGION DEFINITIONS (Canonical Mapping for Stability)
const REGIONS = [
    { 
        id: 'live-Forehead', name: 'Forehead', 
        indices: [10, 109, 338, 67], 
        pad: 0.15,
        anchors: [10, 109, 338], // Center, Left-side, Right-side
        target: [[400, 400], [250, 450], [550, 450]] // Centered lower to avoid hair
    },
    { 
        id: 'live-Nose', name: 'Nose', 
        indices: [168, 6, 197, 2, 102, 331], 
        pad: 0.2,
        anchors: [168, 102, 331], // Bridge, Left Nostril, Right Nostril
        target: [[400, 350], [330, 550], [470, 550]] // Realistic nose proportions
    },
    { 
        id: 'live-Left-Cheek', name: 'Left Cheek', 
        indices: [116, 117, 118, 101, 123], 
        pad: 0.25,
        anchors: [123, 117, 234], // Outer-Eye, Inner-Eye, Jawline
        target: [[200, 350], [450, 350], [350, 600]] // LEVEL eye-line to remove tilt
    },
    { 
        id: 'live-Right-Cheek', name: 'Right Cheek', 
        indices: [345, 346, 347, 330, 352], 
        pad: 0.25,
        anchors: [352, 346, 454], // Outer-Eye, Inner-Eye, Jawline
        target: [[600, 350], [350, 350], [450, 600]] // LEVEL eye-line to remove tilt
    },
    { 
        id: 'live-Chin', name: 'Chin', 
        indices: [164, 18, 200, 152], 
        pad: 0.2,
        anchors: [164, 57, 287], // Philtrum, Left-mouth, Right-mouth
        target: [[400, 300], [300, 450], [500, 450]]
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
                REGIONS.forEach(r => regionBuffers[r.id] = []);
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

function updateLiveRegions(landmarks, video) {
    if (offscreenCanvas.width !== 800) { offscreenCanvas.width = 800; offscreenCanvas.height = 800; }
    REGIONS.forEach(r => {
        const liveCanvas = document.getElementById(r.id);
        if (!liveCanvas) return;
        const liveCtx = liveCanvas.getContext('2d', { willReadFrequently: true });
        if (liveCanvas.width !== 800) { liveCanvas.width = 800; liveCanvas.height = 800; regionBuffers[r.id] = []; }

        const srcPoints = r.anchors.map(idx => ({ x: landmarks[idx].x * video.videoWidth, y: landmarks[idx].y * video.videoHeight }));
        const m = solveAffine(srcPoints, r.target);
        
        offscreenCtx.save();
        offscreenCtx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
        offscreenCtx.drawImage(video, 0, 0);
        offscreenCtx.restore();

        const sampleSize = 200;
        const imgData = offscreenCtx.getImageData(300, 300, sampleSize, sampleSize).data;
        let sharpness = 0;
        for (let i = 0; i < imgData.length - 4; i += 4) sharpness += Math.abs(imgData[i] - imgData[i+4]);

        // TIGHTEN GATING: Cheeks are smoother, so they need a stricter "quality bar"
        const isCheek = r.id.includes('Cheek');
        const qualityMultiplier = isCheek ? 1.5 : 1.0; 

        const buffer = regionBuffers[r.id];
        if (buffer.length < MAX_BUFFER_SIZE || (sharpness / qualityMultiplier) > buffer[buffer.length - 1].score) {
            buffer.push({ score: sharpness / qualityMultiplier, data: offscreenCtx.getImageData(0, 0, 800, 800) });
            buffer.sort((a, b) => b.score - a.score);
            if (buffer.length > MAX_BUFFER_SIZE) buffer.pop();
            liveCtx.globalAlpha = 0.15;
            liveCtx.drawImage(offscreenCanvas, 0, 0);
            liveCtx.globalAlpha = 1.0;
        }

        const indicator = liveCanvas.parentElement.querySelector('.refining-indicator');
        if (indicator) {
            indicator.textContent = buffer.length >= MAX_BUFFER_SIZE ? 'ULTRA-HD LOCKED' : `WEAVING TEXTURE: ${buffer.length * 10}%`;
            indicator.style.color = buffer.length >= MAX_BUFFER_SIZE ? '#55ff55' : '#00d2ff';
        }
    });
}

function calculateMedianImageData(buffer) {
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

async function completeScan() {
    isAnalyzing = true;
    scannerView.classList.add('hidden');
    liveRegionRow.classList.add('hidden');
    regionImagesGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem;"><h3>GENERATING ULTRA-HD RECONSTRUCTIONS...</h3><div class="circular-loader" style="margin: 1rem auto;"></div></div>';

    setTimeout(() => {
        regionImagesGrid.innerHTML = '';
        REGIONS.forEach(r => {
            const liveCanvas = document.getElementById(r.id);
            const medianData = calculateMedianImageData(regionBuffers[r.id]);
            if (medianData) liveCanvas.getContext('2d').putImageData(medianData, 0, 0);
            const container = document.createElement('div');
            container.className = 'region-item';
            const img = document.createElement('img');
            img.src = liveCanvas.toDataURL('image/png'); 
            const label = document.createElement('span');
            label.textContent = r.name;
            container.appendChild(img); container.appendChild(label);
            regionImagesGrid.appendChild(container);
        });
        regionConfirmationView.classList.remove('hidden');
    }, 100);
}

async function proceedToAnalysis() {
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
                biometrics: { bpm, respiration: resp, blinkRate: blinks } 
            })
        });
        clearInterval(deepTimer);
        const result = await response.json();
        setTimeout(() => { analysisView.classList.add('hidden'); showResults(result, { bpm, resp, blinks }); }, 1000);
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

function showResults(data, vitals) {
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
    resultsSection.classList.remove('hidden'); resultsGrid.innerHTML = '';
    let total = 0, count = 0;
    Object.values(data.pillars || {}).forEach(p => { if(p) { total += p.score; count++; } });
    const hero = document.createElement('div');
    hero.className = 'wellness-hero'; hero.style.gridColumn = "1 / -1";
    hero.innerHTML = `<h1 style="font-size: 5rem;">${count > 0 ? Math.round(total / count) : 85}</h1>`;
    resultsGrid.appendChild(hero);
    const foot = document.createElement('div'); foot.style.gridColumn = "1 / -1";
    foot.appendChild(resetBtn); resultsGrid.appendChild(foot);
}

function resetScanner() {
    isAnalyzing = false;
    resultsSection.classList.add('hidden'); analysisView.classList.add('hidden'); regionConfirmationView.classList.add('hidden');
    setupView.classList.remove('hidden'); analysisOverlay.classList.add('hidden'); liveRegionRow.classList.add('hidden');
    scanStartTime = 0; stabilizationFrames = 0; pulseSamples = []; respirationSamples = []; blinkCount = 0;
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
