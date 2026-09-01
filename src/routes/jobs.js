const express = require('express');
const { triageQueue } = require('../queue/triageQueue');

const router = express.Router();

router.get('/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        const job = await triageQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({
                error: 'Job not found',
                jobId,
            });
        }

        const state = await job.getState();

        const response = {
            jobId: job.id,
            status: state,
        };

        if (state === 'completed') {
            response.result = job.returnvalue;
        }

        if (state === 'failed') {
            response.error = job.failedReason;
        }

        return res.json(response);
    } catch (err) {
        console.error('[Jobs API] Failed to get job status:', err);

        return res.status(500).json({
            error: 'Failed to retrieve job status',
        });
    }
});

module.exports = router;