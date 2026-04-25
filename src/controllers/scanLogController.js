const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '../../logs');

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function safeFilename(iso) {
    return iso.replace(/[:.]/g, '-');
}

async function saveScanLog(req, res) {
    try {
        ensureLogsDir();
        const now      = new Date();
        const filename = `scan_${safeFilename(now.toISOString())}.json`;
        const filepath = path.join(LOGS_DIR, filename);
        const body     = { savedAt: now.toISOString(), ...req.body };
        fs.writeFileSync(filepath, JSON.stringify(body, null, 2), 'utf8');
        console.log(`[scan-log] saved → ${filename}  (${req.body?.entries?.length ?? 0} entries)`);
        return res.json({ success: true, filename });
    } catch (err) {
        console.error('[scan-log] save error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function listScanLogs(req, res) {
    try {
        ensureLogsDir();
        const files = fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse(); // newest first
        return res.json({ success: true, count: files.length, logs: files });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function getScanLog(req, res) {
    try {
        // Prevent path traversal
        const filename = path.basename(req.params.filename);
        const filepath = path.join(LOGS_DIR, filename);
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, message: 'Log not found' });
        }
        return res.json(JSON.parse(fs.readFileSync(filepath, 'utf8')));
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

module.exports = { saveScanLog, listScanLogs, getScanLog };
