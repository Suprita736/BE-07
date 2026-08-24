const fs = require('fs');
const path = require('path');
const app = require('../server');
const client = require('../llm/client');

const PORT = 3005;
const BASE_URL = `http://localhost:${PORT}`;
const QUARANTINE_PATH = path.join(__dirname, '..', '..', 'logs', 'quarantine.jsonl');

let server;
let callCount = 0;
let mockResponses = [];

// Override client.chat.completions.create
const originalCreate = client.chat.completions.create;
client.chat.completions.create = async (options) => {
    callCount++;
    const nextResponse = mockResponses.shift();
    if (!nextResponse) {
        throw new Error('No mock response configured for this call');
    }
    if (nextResponse.shouldThrow) {
        throw new Error(nextResponse.errorMessage || 'Simulated provider error');
    }
    return {
        choices: [
            {
                message: {
                    content: nextResponse.content,
                },
            },
        ],
    };
};

function setupMock(responses) {
    callCount = 0;
    mockResponses = responses;
}

function clearQuarantineFile() {
    if (fs.existsSync(QUARANTINE_PATH)) {
        fs.unlinkSync(QUARANTINE_PATH);
    }
}

async function runTests() {
    // Start the server
    server = app.listen(PORT);
    console.log(`Test server running on ${BASE_URL}`);

    // Set default envs for tests
    process.env.LLM_MODEL = 'mocked-model';

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

    // Test 1: A valid model response returns HTTP 200
    await assertTest('Test 1: Valid model response returns HTTP 200', async () => {
        process.env.LLM_STUB = '0';
        setupMock([
            {
                content: JSON.stringify({
                    category: 'bug',
                    urgency: 'high',
                    confidence: 0.9,
                    reason: 'App crashes on start',
                }),
            },
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'App is crashing' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        const data = await res.json();
        if (data.category !== 'bug') throw new Error(`Expected category "bug", got "${data.category}"`);
        if (callCount !== 1) throw new Error(`Expected exactly 1 LLM call, got ${callCount}`);
    });

    // Test 2: Invalid JSON from the first response triggers exactly ONE repair attempt
    // Test 3: A valid repair response returns HTTP 200
    await assertTest('Test 2 & 3: Invalid first response triggers exactly ONE repair resulting in HTTP 200', async () => {
        process.env.LLM_STUB = '0';
        setupMock([
            { content: 'this is not json at all' }, // First call returns invalid JSON
            {
                content: JSON.stringify({
                    category: 'billing',
                    urgency: 'normal',
                    confidence: 0.99,
                    reason: 'Corrected duplicate charge info',
                }),
            }, // Repair response
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Double charged on invoice' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        const data = await res.json();
        if (data.category !== 'billing') throw new Error(`Expected category "billing", got "${data.category}"`);
        if (callCount !== 2) throw new Error(`Expected exactly 2 LLM calls (1 original + 1 repair), got ${callCount}`);
    });

    // Test 4: Invalid first response + invalid repair response results in HTTP 422, quarantine log, no 3rd call
    await assertTest('Test 4: Invalid first + invalid repair returns 422 and logs to quarantine', async () => {
        process.env.LLM_STUB = '0';
        clearQuarantineFile();

        setupMock([
            { content: '{"invalid": "schema"}' }, // Fails Zod output validation
            { content: 'still invalid repair output' }, // Fails JSON parse
        ]);

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Request help please' }),
        });

        if (res.status !== 422) throw new Error(`Expected status 422, got ${res.status}`);
        const data = await res.json();
        if (data.error !== 'Unable to produce valid triage result') {
            throw new Error(`Expected error message, got: ${JSON.stringify(data)}`);
        }
        if (callCount !== 2) throw new Error(`Expected exactly 2 LLM calls, got ${callCount}`);

        // Verify quarantine file contents
        if (!fs.existsSync(QUARANTINE_PATH)) {
            throw new Error('Quarantine file was not created');
        }

        const lines = fs.readFileSync(QUARANTINE_PATH, 'utf-8').trim().split('\n');
        if (lines.length !== 1) {
            throw new Error(`Expected exactly 1 quarantine log line, got ${lines.length}`);
        }

        const record = JSON.parse(lines[0]);
        if (record.requestText !== 'Request help please') {
            throw new Error(`Expected requestText to match, got: ${record.requestText}`);
        }
        if (record.rawResponse !== '{"invalid": "schema"}') {
            throw new Error(`Expected rawResponse to match, got: ${record.rawResponse}`);
        }
        if (record.repairResponse !== 'still invalid repair output') {
            throw new Error(`Expected repairResponse to match, got: ${record.repairResponse}`);
        }
        if (!record.error) {
            throw new Error('Expected error description to be logged in quarantine');
        }
    });

    // Test 5: LLM_STUB=1 still works and its output passes Zod validation
    await assertTest('Test 5: LLM_STUB=1 bypasses LLM calls and passes output validation', async () => {
        process.env.LLM_STUB = '1';
        setupMock([]); // No mock responses, shouldn't call LLM

        const res = await fetch(`${BASE_URL}/triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Stub test message' }),
        });

        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        const data = await res.json();
        if (data.category !== 'other') throw new Error(`Expected stub category "other", got "${data.category}"`);
        if (callCount !== 0) throw new Error(`Expected 0 LLM calls, got ${callCount}`);
    });

    // Clean up
    server.close();
    clearQuarantineFile();
    console.log(`\nTests finished. Passed: ${passed}, Failed: ${failed}`);
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

