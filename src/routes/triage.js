const express = require('express');
const { TriageInputSchema } = require('../llm/schema');
const { triageQueue } = require('../queue/triageQueue');

const router = express.Router();

router.post('/', async (req, res) => {
    // Guard: body must exist and be an object
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
            error: 'Invalid input',
            details: [
                {
                    field: 'body',
                    message: 'Request body must be JSON',
                },
            ],
        });
    }

    // Validate input before creating a job
    const parseResult = TriageInputSchema.safeParse(req.body);

    if (!parseResult.success) {
        const details = parseResult.error.issues.map((e) => ({
            field: e.path.length > 0 ? e.path.join('.') : 'text',
            message: e.message,
        }));

        return res.status(400).json({
            error: 'Invalid input',
            details,
        });
    }

    // Kill switch: do not accept jobs when AI is disabled
    if (process.env.LLM_ENABLED === 'false') {
        return res.status(503).json({
            error: 'AI service is currently disabled',
        });
    }

    try {
        const requestId =
            req.headers['idempotency-key'] ||
            req.body.requestId;

        if (!requestId) {
            return res.status(400).json({
                error: 'Missing idempotency key',
                message: 'Provide an Idempotency-Key header or requestId in the body',
            });
        }

        const jobId = `triage-${requestId}`;

        const job = await triageQueue.add(
            'triage-message',
            {
                text: parseResult.data.text,
                requestId,
            },
            {
                jobId,
            }
        );
        console.log(`[API] Created triage job ${job.id}`);

        return res.status(202).json({
            jobId: job.id,
            status: 'queued',
        });
    } catch (err) {
        console.error('[API] Failed to enqueue triage job:', err);

        return res.status(500).json({
            error: 'Failed to create background job',
        });
    }
});

module.exports = router;