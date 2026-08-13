async function withTimeout(factory, timeoutMs, timeoutMessage) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage || "Operation timed out")), timeoutMs);
  });

  try {
    return await Promise.race([factory(), timer]);
  } finally {
    clearTimeout(timeout);
  }
}

async function retry(fn, options = {}) {
  const retries = options.retries == null ? 2 : options.retries;
  const delayMs = options.delayMs || 300;
  let lastError;

  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      if (i === retries) break;
      await sleep(delayMs * (i + 1));
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  withTimeout,
  retry
};
