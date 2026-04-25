const express = require('express');
const router  = express.Router();
const { saveScanLog, listScanLogs, getScanLog } = require('../controllers/scanLogController');

router.post('/',          saveScanLog);   // called by frontend after each scan
router.get('/',           listScanLogs);  // list all saved log files
router.get('/:filename',  getScanLog);    // fetch a specific log by filename

module.exports = router;
