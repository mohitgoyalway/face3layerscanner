require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const analyzeRoute = require("./routes/analyze");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

// Serve static files from the 'src' directory
app.use(express.static(path.join(__dirname)));

// Route to serve index.html explicitly if needed
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Face Wellness API",
    timestamp: new Date()
  });
});

app.use("/analyze", analyzeRoute);
app.use("/analyze-face", analyzeRoute);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: "Server error" });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Demo available at: http://localhost:${PORT}/`);
});
