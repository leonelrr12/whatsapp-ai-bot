const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(delay * Math.pow(2, i));
    }
  }
  throw lastError;
}

module.exports = {
  sleep,
  retryWithBackoff,
};
