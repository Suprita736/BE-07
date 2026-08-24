require('dotenv').config();
const express = require('express');
const triageRouter = require('./routes/triage');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'AI Triage API is running' });
});

// Triage route
app.use('/triage', triageRouter);

// Global error handler for malformed JSON bodies
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
    next(err);
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;

