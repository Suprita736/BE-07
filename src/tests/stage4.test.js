const fs = require('fs');
const path = require('path');
const app = require('../server');
const { client } = require('../llm/client');

const PORT = 3006;
const BASE_URL = `http://localhost:${PORT}`;
const USAGE_PATH = path.join(__dirname, '..', '..', 'logs', 'llm-usage.jsonl');

let server;
let callCount = 0;
let callTimestamps = [];
let mockResponses = [];

// Override client.chat.completions.create
client.chat.completions.create = async (options) => {
    callCount++;
    callTimestamps.push(Date.now());
    const nextResponse = mockResponses.shift();
    if (!nextResponse) {
        throw new Error('No mock response configured for this call');
    }
    if (nextResponse.shouldThrow) {
        const err = new Error(nextResponse.errorMessage || 'Simulated provider error');
        err.name = nextResponse.errorName || 'APIError';
        err.status = nextResponse.status;
        throw err;
    }
    return {
        model: options.model || 'mocked-model',
        choices: [
            {
                message: {
                    content: nextResponse.content,
                },
            },
        ],
        usage: nextResponse.usage || null,
    };
};

function setupMock(responses) {
    callCount = 0;
    callTimestamps = [];
    mockResponses = responses;
}

function clearUsageFile() {
    if (fs.existsSync(USAGE_PATH)) {
        fs.unlinkSync(USAGE_PATH);
    }
}

async function runTests() {
    // Start the server
    server = app.listen(PORT);
    console.log(`Test server running on ${BASE_URL}`);

    // Set default envs for tests
    process.env.LLM_MODEL = 'mocked-model';
    process.env.LLM_TIMEOUT_MS = '1000';
    process.env.LLM_MAX_RETRIES = '2';
    process.env.LLM_RETRY_BASE_MS = '20';

    let passed = 0;
    let failed = 0;

    async function assertTest(name, fn) {
        try {
            console.log(`\nRunning: ${name}`);
            await fn();
            console.log(`✔ Passed: ${name}`);
            passed++;
        } catch (err) {
            console.error(`✘ Failed: ${name}`);
            console.error(err);
            failed++;
        }
    }

    // Test A: Successful LLM request -> HTTP 200
    await assertTest('Test A: Successful LLM request -> HTTP 200', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        setupMock([
            {
                content: JSON.stringify({
                    category: 'bug',
                    urgency: 'high',
                    confidence: 0.9,
                    reason: 'Issue verified',
                }),
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Valid test text' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        const data = await res.json();
        if (data.category !== 'bug') throw new Error(`Expected category "bug", got "${data.category}"`);
        if (callCount !== 1) throw new Error(`Expected exactly 1 call, got ${callCount}`);
    });

    // Test B: Timeout -> retry occurs
    await assertTest('Test B: Timeout error triggers retry and succeeds', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        setupMock([
            { shouldThrow: true, errorName: 'APIConnectionTimeoutError', errorMessage: 'Request timed out' },
            {
                content: JSON.stringify({
                    category: 'billing',
                    urgency: 'low',
                    confidence: 0.95,
                    reason: 'Recovered after timeout',
                }),
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Recover me' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        if (callCount !== 2) throw new Error(`Expected exactly 2 calls (1 timeout retry + 1 success), got ${callCount}`);
    });

    // Test C: 429 -> retry occurs
    await assertTest('Test C: HTTP 429 triggers retry and succeeds', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        setupMock([
            { shouldThrow: true, status: 429, errorMessage: 'Rate limit exceeded' },
            {
                content: JSON.stringify({
                    category: 'feature',
                    urgency: 'normal',
                    confidence: 0.95,
                    reason: 'Recovered after 429',
                }),
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Feature request please' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        if (callCount !== 2) throw new Error(`Expected exactly 2 calls, got ${callCount}`);
    });

    // Test D: 500 -> retry occurs
    await assertTest('Test D: HTTP 500 triggers retry and succeeds', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        setupMock([
            { shouldThrow: true, status: 500, errorMessage: 'Internal Server Error' },
            {
                content: JSON.stringify({
                    category: 'other',
                    urgency: 'low',
                    confidence: 0.5,
                    reason: 'Recovered after 500',
                }),
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'General inquiry' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        if (callCount !== 2) throw new Error(`Expected exactly 2 calls, got ${callCount}`);
    });

    // Test E: A non-retryable 400/401/403 error -> NO retry
    await assertTest('Test E: Non-transient HTTP 401 does NOT retry', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        setupMock([
            { shouldThrow: true, status: 401, errorMessage: 'Invalid API Key' },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Authorize me' }),
        });

        if (res.status !== 500) throw new Error(`Expected status 500, got ${res.status}`);
        if (callCount !== 1) throw new Error(`Expected exactly 1 call (no retries), got ${callCount}`);
    });

    // Test F: Maximum retry limit is respected
    await assertTest('Test F: Maximum retry limit (LLM_MAX_RETRIES) is respected', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        process.env.LLM_MAX_RETRIES = '2';

        setupMock([
            { shouldThrow: true, status: 502, errorMessage: 'Bad Gateway' }, // Initial
            { shouldThrow: true, status: 503, errorMessage: 'Service Unavailable' }, // Retry 1
            { shouldThrow: true, status: 504, errorMessage: 'Gateway Timeout' }, // Retry 2 (max reached)
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Continuous errors' }),
        });

        if (res.status !== 500) throw new Error(`Expected status 500, got ${res.status}`);
        if (callCount !== 3) throw new Error(`Expected exactly 3 calls (1 initial + 2 retries), got ${callCount}`);
    });

    // Test G: Backoff increases and includes jitter
    await assertTest('Test G: Backoff increases and contains random jitter', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        process.env.LLM_MAX_RETRIES = '2';
        process.env.LLM_RETRY_BASE_MS = '100'; // Make intervals larger to measure easily

        setupMock([
            { shouldThrow: true, status: 500, errorMessage: 'Error 1' },
            { shouldThrow: true, status: 500, errorMessage: 'Error 2' },
            {
                content: JSON.stringify({
                    category: 'other',
                    urgency: 'low',
                    confidence: 0.5,
                    reason: 'Success',
                }),
            },
        ]);

        const startTime = Date.now();
        await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Backoff test' }),
        });

        const diff1 = callTimestamps[1] - callTimestamps[0];
        const diff2 = callTimestamps[2] - callTimestamps[1];

        console.log(`Delay 1: ${diff1}ms, Delay 2: ${diff2}ms`);

        // With baseDelay = 100ms:
        // Delay 1: 100 * 2^0 + jitter (0..100) = 100..200ms
        // Delay 2: 100 * 2^1 + jitter (0..100) = 200..300ms
        if (diff1 < 90) throw new Error(`Expected Delay 1 to be at least ~100ms, got ${diff1}ms`);
        if (diff2 < 190) throw new Error(`Expected Delay 2 to be at least ~200ms, got ${diff2}ms`);
        if (diff2 <= diff1) throw new Error(`Expected Delay 2 (${diff2}ms) to be larger than Delay 1 (${diff1}ms) due to exponential backoff`);
    });

    // Test H: LLM_ENABLED=false -> HTTP 503 and zero LLM calls
    await assertTest('Test H: LLM_ENABLED=false returns HTTP 503 and bypasses all LLM calls', async () => {
        process.env.LLM_ENABLED = 'false';
        process.env.LLM_STUB = '0';
        setupMock([]); // No mock responses needed since it should not call client

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Test kill switch' }),
        });

        if (res.status !== 503) throw new Error(`Expected status 503, got ${res.status}`);
        const data = await res.json();
        if (data.error !== 'AI service is currently disabled') {
            throw new Error(`Expected AI disabled error, got: ${JSON.stringify(data)}`);
        }
        if (callCount !== 0) throw new Error(`Expected 0 LLM calls, got ${callCount}`);
    });

    // Test I: LLM_STUB=1 -> zero LLM calls and existing stub still works
    await assertTest('Test I: LLM_STUB=1 bypasses LLM and returns validated stub response', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '1';
        setupMock([]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Test stub mode' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        const data = await res.json();
        if (data.category !== 'other') throw new Error(`Expected stub category "other", got "${data.category}"`);
        if (callCount !== 0) throw new Error(`Expected 0 LLM calls, got ${callCount}`);
    });

    // Test J: Successful response with usage metadata creates one llm-usage.jsonl record
    await assertTest('Test J: Successful response with usage metadata writes usage log', async () => {
        process.env.LLM_ENABLED = 'true';
        process.env.LLM_STUB = '0';
        clearUsageFile();

        setupMock([
            {
                content: JSON.stringify({
                    category: 'bug',
                    urgency: 'high',
                    confidence: 0.9,
                    reason: 'Log writing verification',
                }),
                usage: {
                    prompt_tokens: 15,
                    completion_tokens: 25,
                    total_tokens: 40,
                },
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Write usage log' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        if (!fs.existsSync(USAGE_PATH)) {
            throw new Error('LLM usage log file was not created');
        }

        const lines = fs.readFileSync(USAGE_PATH, 'utf-8').trim().split('\n');
        if (lines.length !== 1) {
            throw new Error(`Expected exactly 1 usage log record, got ${lines.length}`);
        }

        const record = JSON.parse(lines[0]);
        if (record.promptTokens !== 15 || record.completionTokens !== 25 || record.totalTokens !== 40) {
            throw new Error(`Usage metadata mismatch in log record: ${JSON.stringify(record)}`);
        }
        if (!record.timestamp || record.model !== 'mocked-model') {
            throw new Error(`Record header metadata mismatch: ${JSON.stringify(record)}`);
        }
    });

    // Cleanup and exit
    server.close();
    clearUsageFile();
    console.log(`\nAll Stage 4 tests finished. Passed: ${passed}, Failed: ${failed}`);
    setTimeout(() => {
        process.exit(failed > 0 ? 1 : 0);
    }, 100);
}

runTests().catch((err) => {
    console.error('Test suite crashed:', err);
    if (server) server.close();
    setTimeout(() => {
        process.exit(1);
    }, 100);
});
