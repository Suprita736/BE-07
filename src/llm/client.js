const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  timeout: parseInt(process.env.LLM_TIMEOUT_MS) || 30000,
});

const USAGE_PATH = path.join(__dirname, '..', '..', 'logs', 'llm-usage.jsonl');

function logUsage(response) {
  try {
    const usage = response.usage;
    const logsDir = path.dirname(USAGE_PATH);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const record = {
      timestamp: new Date().toISOString(),
      model: response.model || process.env.LLM_MODEL || 'unknown',
      promptTokens: usage ? usage.prompt_tokens : null,
      completionTokens: usage ? usage.completion_tokens : null,
      totalTokens: usage ? usage.total_tokens : null,
    };

    fs.appendFileSync(USAGE_PATH, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to log LLM usage:', e.message);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransient = (error) => {
  // Check OpenAI SDK error classes
  if (
    error.name === 'APIConnectionTimeoutError' ||
    error.name === 'APIConnectionError' ||
    error.message?.includes('timeout')
  ) {
    return true;
  }
  // Check HTTP status code
  const transientStatuses = [429, 500, 502, 503, 504];
  if (error.status && transientStatuses.includes(error.status)) {
    return true;
  }
  return false;
};

async function executeCompletionWithSafeguards(params) {
  const maxRetries = process.env.LLM_MAX_RETRIES !== undefined 
    ? parseInt(process.env.LLM_MAX_RETRIES) 
    : 2;
  const baseDelay = parseInt(process.env.LLM_RETRY_BASE_MS) || 250;

  let attempt = 0;
  while (true) {
    try {
      const response = await client.chat.completions.create(params);
      logUsage(response);
      return response;
    } catch (error) {
      if (attempt < maxRetries && isTransient(error)) {
        // delay = baseDelay * 2^attempt + random jitter
        const exponential = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * baseDelay;
        const backoffMs = exponential + jitter;

        console.warn(`[LLM Client] Transient error: "${error.message}". Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(backoffMs)}ms...`);
        await delay(backoffMs);
        attempt++;
      } else {
        throw error;
      }
    }
  }
}

module.exports = {
  client,
  executeCompletionWithSafeguards,
};
