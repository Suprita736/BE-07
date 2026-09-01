require('dotenv').config();

const { triageQueue, connection } = require('./triageQueue');

async function main() {
    const job = await triageQueue.add('test-job', {
        text: 'This is a test ticket',
    });

    console.log('Job created:', job.id);

    await connection.quit();
}

main().catch((err) => {
    console.error('Queue test failed:', err);
    process.exit(1);
});