const express = require('express');
const { TriageInputSchema } = require('../llm/schema');

const router = express.Router();

// Deterministic stub response returned when LLM_STUB=1
const STUB_RESPONSE = {
    category: 'other',
    urgency: 'normal',
    confidence: 0.5,
    reason: 'Stub response for local development.',
};

router.post('/', (req, res) => {
    // Guard: body must exist and be an object (i.e. Content-Type: application/json was parsed)
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

    // Stub mode: skip LLM entirely
    if (process.env.LLM_STUB === '1') {
        return res.json(STUB_RESPONSE);
    }

    // Real LLM call will be wired in Stage 2
    return res.status(501).json({ error: 'LLM integration not yet implemented.' });
});

module.exports = router;
