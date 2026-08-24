const express = require('express');
const fs = require('fs');
const path = require('path');
const { TriageInputSchema, TriageOutputSchema } = require('../llm/schema');
const { triageMessage } = require('../llm/triage');

const router = express.Router();

const QUARANTINE_PATH = path.join(__dirname, '..', '..', 'logs', 'quarantine.jsonl');

function logToQuarantine(requestText, rawResponse, repairResponse, error) {
    const logsDir = path.dirname(QUARANTINE_PATH);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const logRecord = {
        timestamp: new Date().toISOString(),
        requestText,
        model: process.env.LLM_MODEL || 'unknown',
        rawResponse,
        repairResponse,
        error,
    };

    fs.appendFileSync(QUARANTINE_PATH, JSON.stringify(logRecord) + '\n', 'utf-8');
}

// Deterministic stub response returned when LLM_STUB=1
const STUB_RESPONSE = {
    category: 'other',
    urgency: 'normal',
    confidence: 0.5,
    reason: 'Stub response for local development.',
};

router.post('/', async (req, res) => {
    // Guard: body must exist and be an object
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid input', details: [{ field: 'body', message: 'Request body must be JSON' }] });
    }

    // Validate input before any model call
    const parseResult = TriageInputSchema.safeParse(req.body);

    if (!parseResult.success) {
        const details = parseResult.error.issues.map((e) => ({
            field: e.path.length > 0 ? e.path.join('.') : 'text',
            message: e.message,
        }));
        return res.status(400).json({ error: 'Invalid input', details });
    }

    // Kill switch: return 503 if AI is disabled
    if (process.env.LLM_ENABLED === 'false') {
        return res.status(503).json({ error: 'AI service is currently disabled' });
    }

    // Stub mode: skip LLM entirely, but still validate output against schema
    if (process.env.LLM_STUB === '1') {
        const validationResult = TriageOutputSchema.safeParse(STUB_RESPONSE);
        if (!validationResult.success) {
            return res.status(500).json({ error: 'Stub response failed output validation', details: validationResult.error.issues });
        }
        return res.json(validationResult.data);
    }

    try {
        const result = await triageMessage(req.body.text);

        if (result.success) {
            return res.json(result.data);
        } else {
            // Quarantine the failure
            logToQuarantine(
                req.body.text,
                result.rawResponse,
                result.repairResponse,
                result.error
            );
            return res.status(422).json({
                error: 'Unable to produce valid triage result',
            });
        }
    } catch (err) {
        // Handle unexpected API/network/internal errors
        return res.status(500).json({
            error: 'LLM request failed',
            message: err.message,
        });
    }
});

module.exports = router;
