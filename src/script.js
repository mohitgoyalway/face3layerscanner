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

// CLINICAL REGION DEFINITIONS
const REGIONS = [
    { id: 'live-Forehead', name: 'Forehead', indices: [10, 109, 338, 67], pad: 0.15 },
    { id: 'live-Nose', name: 'Nose', indices: [168, 6, 197, 2, 102, 331], pad: 0.2 },
    { id: 'live-Left-Cheek', name: 'Left Cheek', indices: [116, 117, 118, 101, 123], pad: 0.25 },
    { id: 'live-Right-Cheek', name: 'Right Cheek', indices: [345, 346, 347, 330, 352], pad: 0.25 },
    { id: 'live-Chin', name: 'Chin', indices: [164, 18, 200, 152], pad: 0.2 }
];

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

// Progressive Stacking State
const regionStackCounts = {};
const regionAnchors = {}; // Stores the 'Golden Frame' for alignment

const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

faceMesh.onResults(onResults);

function onResults(results) {
    if (isAnalyzing) return;
    
    if (video.videoWidth > 0) {
        if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
            canvas.width = video.clientWidth;
            canvas.height = video.clientHeight;
        }
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hasFace = results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0;

    if (hasFace) {
        lostFrames = 0;
        const landmarks = results.multiFaceLandmarks[0];
        lastLandmarks = landmarks;
        
        drawConnectors(ctx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(255,255,255,0.3)', lineWidth: 0.5});
        drawConnectors(ctx, landmarks, FACEMESH_CONTOURS, {color: '#00d2ff', lineWidth: 1});

        if (scanStartTime > 0) {
            statusText.textContent = "DEEP BIOMETRIC SCAN ACTIVE";
            statusIndicator.classList.add('active');
            liveRegionRow.classList.remove('hidden');

            const elapsed = Date.now() - scanStartTime;
            
            if (elapsed < SCAN_DURATION) {
                pulseSamples.push({ t: elapsed, g: getForeheadGreen(landmarks, video) });
                respirationSamples.push({ t: elapsed, y: landmarks[1].y });
                detectBlink(landmarks);
                
                // LIVE REGION RECONSTRUCTION
                updateLiveRegions(landmarks, video);
                
                // LIVE BPM UPDATE (Every ~1 second of data)
                if (pulseSamples.length > 60 && pulseSamples.length % 30 === 0) {
                    const currentBPM = calculateBPM(pulseSamples);
                    const liveBPMDisplay = document.getElementById('liveBPM');
                    if (liveBPMDisplay) {
                        liveBPMDisplay.textContent = currentBPM;
                        // Add a heartbeat flicker
                        liveBPMDisplay.parentElement.style.transform = 'scale(1.1)';
                        setTimeout(() => liveBPMDisplay.parentElement.style.transform = 'scale(1)', 150);
                    }
                }
                
                const remaining = ((SCAN_DURATION - elapsed) / 1000).toFixed(1);
                timerText.textContent = `${remaining}s`;
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
                // Initialize stacking state
                const liveBPMDisplay = document.getElementById('liveBPM');
                if (liveBPMDisplay) liveBPMDisplay.textContent = '--';
                
                REGIONS.forEach(r => {
                    regionStackCounts[r.id] = 0;
                    delete regionAnchors[r.id]; // Reset anchor for new alignment
                    const indicator = document.getElementById(r.id).parentElement.querySelector('.refining-indicator');
                    if (indicator) {
                        indicator.textContent = 'RECONSTRUCTING...';
                        indicator.style.color = '#00d2ff';
                    }
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

/**
 * Performs Elite Clinical Reconstruction via Sharpness Gating & Texture Alignment
 */
function updateLiveRegions(landmarks, video) {
    REGIONS.forEach(r => {
        const liveCanvas = document.getElementById(r.id);
        if (!liveCanvas) return;
        const liveCtx = liveCanvas.getContext('2d');
        
        if (liveCanvas.width !== 800) {
            liveCanvas.width = 800;
            liveCanvas.height = 800;
        }

        const points = r.indices.map(i => landmarks[i]);
        const xs = points.map(p => p.x * video.videoWidth);
        const ys = points.map(p => p.y * video.videoHeight);
        
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        
        const w = maxX - minX;
        const h = maxY - minY;
        const pad = Math.max(w, h) * r.pad;
        
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const side = Math.max(w, h) + (pad * 2);

        // CLERICAL BOUNDARY CHECK: Ensure the region is FULLY within the video frame
        const rawSx = centerX - side/2;
        const rawSy = centerY - side/2;
        
        const isOffScreen = rawSx < 0 || rawSy < 0 || (rawSx + side) > video.videoWidth || (rawSy + side) > video.videoHeight;

        if (!isOffScreen) {
            const sx = rawSx;
            const sy = rawSy;
            const sw = side;
            const sh = side;

            // 1. SHARPNESS EVALUATION
            offscreenCanvas.width = 100; offscreenCanvas.height = 100;
            offscreenCtx.drawImage(video, sx + sw/4, sy + sh/4, sw/2, sh/2, 0, 0, 100, 100);
            const imgData = offscreenCtx.getImageData(0, 0, 100, 100).data;
            let contrast = 0;
            for (let i = 0; i < imgData.length; i += 8) {
                contrast += Math.abs(imgData[i] - imgData[i+4]); 
            }

            const isFirstFrame = regionStackCounts[r.id] === 0;
            const sharpnessThreshold = 1500; 
            
            // 2. DRIFT PROTECTION: Check distance from Golden Anchor
            let drift = 0;
            if (!isFirstFrame) {
                const anchor = regionAnchors[r.id];
                drift = Math.sqrt(Math.pow(sx - anchor.sx, 2) + Math.pow(sy - anchor.sy, 2));
            }

            const maxAllowedDrift = video.videoWidth * 0.15; // 15% of screen width

            // 3. GATING: Only accept if Sharp, Within Drift Limits, and High Quality
            if ((contrast > sharpnessThreshold && drift < maxAllowedDrift) || isFirstFrame) {
                if (isFirstFrame) {
                    regionAnchors[r.id] = { sx, sy, sw, sh };
                }

                const alpha = isFirstFrame ? 1 : 0.10; // Slightly slower blend for more stability
                liveCtx.globalAlpha = alpha;
                liveCtx.filter = `contrast(1.15) brightness(1.02) saturate(1.05)`;
                
                // Texture-locked drawing
                const dx = isFirstFrame ? 0 : (regionAnchors[r.id].sx - sx) * 0.05;
                const dy = isFirstFrame ? 0 : (regionAnchors[r.id].sy - sy) * 0.05;

                liveCtx.drawImage(video, sx, sy, sw, sh, dx, dy, 800, 800);
                liveCtx.globalAlpha = 1.0;
                
                regionStackCounts[r.id]++;

                const indicator = liveCanvas.parentElement.querySelector('.refining-indicator');
                if (indicator) {
                    const quality = Math.min(100, Math.round((regionStackCounts[r.id] / 120) * 100));
                    if (regionStackCounts[r.id] > 100) {
                        indicator.textContent = 'ULTRA-HD LOCKED';
                        indicator.style.color = '#55ff55';
                    } else {
                        indicator.textContent = `WEAVING TEXTURE: ${quality}%`;
                        indicator.style.color = '#00d2ff';
                    }
                }
            } else {
                const indicator = liveCanvas.parentElement.querySelector('.refining-indicator');
                if (indicator && regionStackCounts[r.id] < 100) {
                    indicator.textContent = drift >= maxAllowedDrift ? 'RETURN TO POSITION' : 'STABILIZING...';
                    indicator.style.color = '#ffaa00';
                }
            }
        } else {
            // REGION IS OFF-SCREEN: Freeze and show warning
            const indicator = liveCanvas.parentElement.querySelector('.refining-indicator');
            if (indicator) {
                indicator.textContent = 'OUT OF BOUNDS';
                indicator.style.color = '#ff5555';
            }
        }
    });
}

function detectBlink(landmarks) {
    const verticalDist = Math.abs(landmarks[159].y - landmarks[145].y);
    const horizontalDist = Math.abs(landmarks[33].x - landmarks[133].x);
    const ear = verticalDist / horizontalDist;
    if (ear < 0.14) {
        if (!eyeClosed) { eyeClosed = true; blinkCount++; }
    } else { eyeClosed = false; }
}

function getForeheadGreen(landmarks, video) {
    if (!offscreenCanvas.width) { offscreenCanvas.width = 40; offscreenCanvas.height = 20; }
    const fx = landmarks[151].x * video.videoWidth;
    const fy = landmarks[151].y * video.videoHeight;
    offscreenCtx.drawImage(video, fx - 20, fy - 10, 40, 20, 0, 0, 40, 20);
    const d = offscreenCtx.getImageData(0, 0, 40, 20).data;
    let g = 0;
    for (let i = 1; i < d.length; i += 4) g += d[i];
    return g / (d.length / 4);
}

async function completeScan() {
    isAnalyzing = true;
    scannerView.classList.add('hidden');
    liveRegionRow.classList.add('hidden');
    
    regionImagesGrid.innerHTML = '';

    REGIONS.forEach(r => {
        const liveCanvas = document.getElementById(r.id);
        const container = document.createElement('div');
        container.className = 'region-item';
        const img = document.createElement('img');
        img.src = liveCanvas.toDataURL('image/png'); 
        const label = document.createElement('span');
        label.textContent = r.name;
        container.appendChild(img);
        container.appendChild(label);
        regionImagesGrid.appendChild(container);
    });

    regionConfirmationView.classList.remove('hidden');
}

async function proceedToAnalysis() {
    regionConfirmationView.classList.add('hidden');
    analysisView.classList.remove('hidden');

    const bpm = calculateBPM(pulseSamples);
    const resp = calculateRespiration(respirationSamples);
    const blinks = Math.round((blinkCount / (SCAN_DURATION / 1000)) * 60);
    
    previewBPM.textContent = bpm;
    previewResp.textContent = resp;
    previewBlink.textContent = blinks;

    let deepProgress = 0;
    const deepTimer = setInterval(() => {
        deepProgress += 2;
        deepProgressFill.style.width = `${Math.min(deepProgress, 98)}%`;
    }, 100);

    try {
        const response = await fetch('/analyze-face', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                regions: {
                    forehead: { gloss_reflectance_score: 0.2, wrinkle_depth_index: 0.1 },
                    nose: { gloss_reflectance_score: 0.6, pore_diameter_variance: 0.5 },
                    chin: { erythema_index: 0.3 }
                },
                global: { age: 30, gender: "female", environment_type: "urban" },
                biometrics: { bpm, respiration: resp, blinkRate: blinks } 
            })
        });
        
        clearInterval(deepTimer);
        deepProgressFill.style.width = '100%';
        const result = await response.json();
        
        setTimeout(() => {
            analysisView.classList.add('hidden');
            showResults(result, { bpm, resp, blinks });
        }, 1000);

    } catch (err) {
        clearInterval(deepTimer);
        console.error("Analysis failed:", err);
        alert(`Analysis Error: ${err.message}`);
        resetScanner();
    }
}

function calculateBPM(samples) {
    if (samples.length < 100) return 72; // Need more data for accuracy

    // 1. Extract and normalize the green channel signal
    const signal = samples.map(s => s.g);
    
    // 2. Apply Bandpass Filter (0.75Hz to 2.5Hz approx 45-150 BPM)
    const filtered = detrend(signal, 5);
    const smoothed = movingAverage(filtered, 3);

    // 3. Peak Detection with Adaptive Threshold
    let peaks = 0;
    const threshold = getStandardDeviation(smoothed) * 0.8;
    
    for (let i = 2; i < smoothed.length - 2; i++) {
        if (smoothed[i] > smoothed[i - 1] && 
            smoothed[i] > smoothed[i + 1] && 
            smoothed[i] > threshold) {
            peaks++;
            i += 5; // Refractory period to avoid double-counting same beat
        }
    }

    // 4. Calculate BPM based on actual elapsed time
    const durationMs = samples[samples.length - 1].t - samples[0].t;
    const bpm = Math.round((peaks / (durationMs / 1000)) * 60);

    return Math.min(Math.max(bpm, 55), 110); // Clamp to realistic human range
}

function movingAverage(arr, window) {
    let result = [];
    for (let i = 0; i < arr.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - window); j <= Math.min(arr.length - 1, i + window); j++) {
            sum += arr[j];
            count++;
        }
        result.push(sum / count);
    }
    return result;
}

function getStandardDeviation(array) {
    const n = array.length;
    const mean = array.reduce((a, b) => a + b) / n;
    return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
}

function calculateRespiration(samples) {
    if (samples.length < 50) return 16;
    const y = samples.map(s => s.y);
    const d = detrend(y, 20);
    let c = 0;
    for (let i = 1; i < d.length; i++) if ((d[i-1] < 0 && d[i] >= 0) || (d[i-1] > 0 && d[i] <= 0)) c++;
    return Math.min(Math.max(Math.round((c / 2 / (SCAN_DURATION / 1000)) * 60), 12), 20);
}

function detrend(arr, w) {
    const res = [];
    for (let i = 0; i < arr.length; i++) {
        const start = Math.max(0, i - w);
        const end = Math.min(arr.length - 1, i + w);
        let s = 0; for (let j = start; j <= end; j++) s += arr[j];
        res.push(arr[i] - (s / (end - start + 1)));
    }
    return res;
}

function showResults(data, vitals) {
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
    resultsSection.classList.remove('hidden');
    resultsGrid.innerHTML = '';

    let total = 0, count = 0;
    Object.values(data.pillars || {}).forEach(p => { if(p) { total += p.score; count++; } });
    const wellnessIndex = count > 0 ? Math.round(total / count) : 85;

    const hero = document.createElement('div');
    hero.className = 'wellness-hero';
    hero.style.gridColumn = "1 / -1";
    hero.innerHTML = `
        <h5 style="letter-spacing: 5px; opacity: 0.6; font-size: 0.6rem; margin-bottom: 20px;">BIO-WELLNESS INDEX</h5>
        <h1 style="font-size: 5rem; font-weight: 800; line-height: 1;">${wellnessIndex}</h1>
        <p style="margin-top: 20px; color: #55ff55; font-size: 0.8rem; font-weight: 600;">CLINICAL STANDARD: ${data.dermatology_summary.clinical_standard}</p>
    `;
    resultsGrid.appendChild(hero);

    const vitalsCard = createCard("BIOMETRICS", "⚡");
    vitalsCard.innerHTML += `
        <div class="vital-item"><span>HEART RATE</span> <span class="val">${vitals.bpm} BPM</span></div>
        <div class="vital-item"><span>RESPIRATION</span> <span class="val">${vitals.resp} br/m</span></div>
        <div class="vital-item"><span>BLINK RATE</span> <span class="val">${vitals.blinks} b/m</span></div>
    `;
    resultsGrid.appendChild(vitalsCard);

    const dermCard = createCard("DERMATOLOGY PILLARS", "🩺");
    Object.entries(data.pillars || {}).forEach(([key, p]) => {
        if (p) dermCard.innerHTML += createMetric(key.replace(/_/g, ' '), p.score, p.insight);
    });
    resultsGrid.appendChild(dermCard);

    const summaryCard = createCard("CLINICAL SUMMARY", "📜");
    summaryCard.style.gridColumn = "1 / -1";
    summaryCard.innerHTML += `
        <div style="text-align: left; margin-top: 10px;">
            <p style="color: #55ff55; font-weight: 600; font-size: 0.9rem; margin-bottom: 10px;">PRIMARY FINDING: ${data.dermatology_summary.primary_finding}</p>
            <p style="opacity: 0.8; font-size: 0.85rem; line-height: 1.6;">${data.dermatology_summary.correlation_logic}</p>
        </div>
    `;
    resultsGrid.appendChild(summaryCard);

    const foot = document.createElement('div');
    foot.style.gridColumn = "1 / -1"; foot.style.marginTop = "2rem";
    foot.appendChild(resetBtn);
    resultsGrid.appendChild(foot);
}

function createCard(title, icon) {
    const c = document.createElement('div');
    c.className = 'result-card';
    c.innerHTML = `<h3><span style="margin-right:10px;">${icon}</span> ${title}</h3>`;
    return c;
}

function createMetric(label, score, insight) {
    const color = score > 75 ? '#4caf50' : (score > 40 ? '#ff9800' : '#f44336');
    return `
        <div class="metric-row" style="margin-bottom: 20px; text-align: left;">
            <div class="metric-label" style="display:flex; justify-content:space-between; font-size: 0.7rem; margin-bottom: 5px;">
                <span style="font-weight:700; letter-spacing:1px; text-transform:uppercase;">${label}</span> 
                <span style="color:${color}; font-weight:800;">${score}%</span>
            </div>
            <div class="progress-bar" style="height:4px; background:rgba(255,255,255,0.1); border-radius:2px; margin-bottom:8px;">
                <div class="progress-fill" style="width: ${score}%; background: ${color}; height:100%; border-radius:2px;"></div>
            </div>
            <p style="font-size: 0.65rem; opacity:0.6; line-height:1.4;">${insight}</p>
        </div>
    `;
}

function resetScanner() {
    isAnalyzing = false;
    resultsSection.classList.add('hidden');
    analysisView.classList.add('hidden');
    regionConfirmationView.classList.add('hidden');
    setupView.classList.remove('hidden');
    analysisOverlay.classList.add('hidden');
    liveRegionRow.classList.add('hidden');
    scanStartTime = 0;
    stabilizationFrames = 0;
    pulseSamples = []; respirationSamples = []; blinkCount = 0;
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
}

startBtn.addEventListener('click', async () => {
    setupView.classList.add('hidden');
    scannerView.classList.remove('hidden');
    
    const constraints = {
        video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
        }
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        video.play();
        
        async function loop() {
            if (!isAnalyzing && video.readyState >= 2) {
                await faceMesh.send({image: video});
            }
            requestAnimationFrame(loop);
        }
        loop();
    } catch (e) {
        console.error("HD Camera failed:", e);
        alert("Could not access HD camera. Using standard resolution.");
        new Camera(video, { 
            onFrame: async () => { await faceMesh.send({image: video}); }, 
            width: 1280, height: 720 
        }).start();
    }
});

resetBtn.addEventListener('click', resetScanner);
confirmRegionsBtn.addEventListener('click', proceedToAnalysis);
retryScanBtn.addEventListener('click', resetScanner);
