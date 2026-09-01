const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),

    // BullMQ requires this setting when using ioredis.
    maxRetriesPerRequest: null,
});

const triageQueue = new Queue('triage', {
    connection,

    defaultJobOptions: {
        attempts: 3,

        backoff: {
            type: 'exponential',
            delay: 1000,
        },

        removeOnComplete: 100,
        removeOnFail: 100,
    },
});

module.exports = {
    triageQueue,
    connection,
};