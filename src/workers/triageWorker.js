require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { connection } = require('../queue/triageQueue');
const { triageMessage } = require('../llm/triage');

const FAILURE_LOG_PATH = path.join(
    __dirname,
    '..',
    '..',
    'logs',
    'failed-jobs.jsonl'
);

function logFailedJob(job, error) {
    const logsDir = path.dirname(FAILURE_LOG_PATH);

    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const record = {
        timestamp: new Date().toISOString(),
        jobId: job?.id,
        requestId: job?.data?.requestId,
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts?.attempts || 1,
        error: error.message,
    };

    fs.appendFileSync(
        FAILURE_LOG_PATH,
        JSON.stringify(record) + '\n',
        'utf8'
    );
}

const worker = new Worker(
    'triage',
    async (job) => {
        console.log(`[Worker] Processing job ${job.id}`);

        const { text } = job.data;

        if (!text) {
            throw new Error('Job is missing required text');
        }

        const result = await triageMessage(text);

        if (!result.success) {
            throw new Error(
                result.error || 'Unable to produce valid triage result'
            );
        }

        console.log(`[Worker] Job ${job.id} completed`);

        return result.data;
    },
    {
        connection,
        concurrency: 2,
    }
);

worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
    console.error(
        `[Worker] Job ${job?.id} failed: ${err.message}`
    );

    // Log only the final failure after all retry attempts.
    const maxAttempts = job?.opts?.attempts || 1;

    if (job && job.attemptsMade >= maxAttempts) {
        logFailedJob(job, err);

        console.error(
            `[ALERT] Job ${job.id} permanently failed after ${job.attemptsMade} attempts`
        );
    }
});

worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err);
});

console.log('Triage worker started and waiting for jobs...');