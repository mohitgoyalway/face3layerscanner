const express = require("express");
const router = express.Router();
const { analyzeFace } = require("../controllers/analyzeController");

router.post("/", analyzeFace);

module.exports = router;
