require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const analyzeRoute  = require("./src/routes/analyze");
const scanLogRoute  = require("./src/routes/scanLog");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

// Explicitly serve static files from the 'src' directory
const srcPath = path.join(__dirname, "src");
console.log("Production: Serving static files from:", srcPath);
app.use(express.static(srcPath));

// Route to serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(srcPath, "index.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date() });
});

app.use("/analyze-face", analyzeRoute);
app.use("/scan-log",    scanLogRoute);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});
