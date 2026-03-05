function countValidMetrics(obj) {
  let count = 0;
  function walk(o) {
    if (o === null || typeof o !== "object") return;
    for (const k in o) {
      if (typeof o[k] === "object") {
        walk(o[k]);
      } else if (typeof o[k] === "number") {
        // In dermatology, 0 is a valid, high-quality measurement (meaning 'not present')
        // We only exclude null/undefined
        count++;
      }
    }
  }
  walk(obj);
  return count;
}

function computeConfidence(input) {
  // We expect roughly 28 core metrics across the face regions
  const totalExpected = 28;
  const present = countValidMetrics(input.regions);
  
  // Confidence is a function of data density
  let c = Math.round((present / totalExpected) * 100);
  
  // Cap it reasonably - you can't be 100% sure with remote sensors
  return Math.min(c, 98);
}

module.exports = { computeConfidence };
