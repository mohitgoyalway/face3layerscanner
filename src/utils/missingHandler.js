function deepFill(obj) {
  if (obj === undefined || obj === null) return null;

  const filled = {};
  let hasData = false;

  for (const key in obj) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      const nested = deepFill(obj[key]);
      if (nested !== null) {
        filled[key] = nested;
        hasData = true;
      }
    } else if (typeof obj[key] === "number") {
      filled[key] = obj[key];
      hasData = true;
    }
  }

  return hasData ? filled : null;
}

function handleMissingMetrics(input) {
  return {
    regions: input.regions || {},
    global: input.global || {},
    longitudinal: input.longitudinal || {}
  };
}

module.exports = { handleMissingMetrics };
