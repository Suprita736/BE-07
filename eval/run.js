require('dotenv').config();
// Force real LLM mode and enable the service for the evaluation
process.env.LLM_STUB = '0';
process.env.LLM_ENABLED = 'true';
process.env.PORT = '3007';

const fs = require('fs');
const path = require('path');
const app = require('../src/server');

const CASES_PATH = path.join(__dirname, 'cases.json');
const BASE_URL = 'http://localhost:3007';
const QUARANTINE_PATH = path.join(__dirname, '..', 'logs', 'quarantine.jsonl');

function clearQuarantine() {
    if (fs.existsSync(QUARANTINE_PATH)) {
        fs.unlinkSync(QUARANTINE_PATH);
    }
}

async function runEvaluation() {
    if (!fs.existsSync(CASES_PATH)) {
        console.error(`Error: cases.json not found at ${CASES_PATH}`);
        process.exit(1);
    }

    clearQuarantine();

    const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8'));
    console.log(`Starting evaluation of ${cases.length} cases via HTTP API...\n`);

    // Start server in-process on port 3007
    const server = app.listen(3007);

    let correctCategory = 0;
    let correctUrgency = 0;
    let totalConfidence = 0;
    let succeededCount = 0;
    
    const incorrect = [];
    const lowConfidence = [];
    const modelValidationFailures = [];
    const providerFailures = [];
    let evaluationStoppedEarly = false;
    let lastEvaluatedIndex = -1;

    // Run sequentially to prevent OpenRouter rate limits
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        lastEvaluatedIndex = i;
        console.log(`[${i + 1}/${cases.length}] Evaluating: "${testCase.text}"`);

        try {
            const res = await fetch(`${BASE_URL}/triage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: testCase.text }),
            });

            // 1. Model Validation Failures (HTTP 422 - failed schema parsing/repair)
            if (res.status === 422) {
                const errData = await res.json();
                console.error(`  ✘ Model validation failure (HTTP 422): ${errData.error}`);
                modelValidationFailures.push({
                    text: testCase.text,
                    expected: testCase.expected,
                    error: 'Unable to produce valid triage result (HTTP 422)',
                });
                continue;
            }

            // 2. Provider/API Failures (HTTP 500, 429, etc.)
            if (res.status !== 200) {
                const errText = await res.text();
                let errMessage;
                try {
                    errMessage = JSON.parse(errText).message || errText;
                } catch {
                    errMessage = errText;
                }

                console.error(`  ✘ Provider/API failure (HTTP ${res.status}): ${errMessage}`);
                providerFailures.push({
                    text: testCase.text,
                    error: errMessage,
                });

                // If daily rate limit hit, stop cleanly
                if (res.status === 429 || errMessage.toLowerCase().includes('rate limit') || errMessage.toLowerCase().includes('429')) {
                    console.warn(`\n[WARNING] OpenRouter daily rate limit reached. Stopping evaluation cleanly.`);
                    evaluationStoppedEarly = true;
                    break;
                }
                continue;
            }

            // 3. Successful prediction
            const prediction = await res.json();
            succeededCount++;
            
            const isCatCorrect = prediction.category === testCase.expected.category;
            const isUrgCorrect = prediction.urgency === testCase.expected.urgency;

            if (isCatCorrect) correctCategory++;
            if (isUrgCorrect) correctUrgency++;
            
            totalConfidence += prediction.confidence;

            const caseDetail = {
                text: testCase.text,
                expectedCategory: testCase.expected.category,
                predictedCategory: prediction.category,
                expectedUrgency: testCase.expected.urgency,
                predictedUrgency: prediction.urgency,
                confidence: prediction.confidence,
                reason: prediction.reason,
            };

            if (!isCatCorrect || !isUrgCorrect) {
                incorrect.push(caseDetail);
            }

            // Define low confidence as less than 0.70
            if (prediction.confidence < 0.7) {
                lowConfidence.push(caseDetail);
            }

            console.log(`  ✔ Category: ${prediction.category} (expected: ${testCase.expected.category}) | Urgency: ${prediction.urgency} (expected: ${testCase.expected.urgency}) | Conf: ${prediction.confidence}`);

        } catch (err) {
            console.error(`  ✘ Provider/API connection error: ${err.message}`);
            providerFailures.push({
                text: testCase.text,
                error: err.message,
            });

            if (err.message.toLowerCase().includes('rate limit') || err.message.toLowerCase().includes('429')) {
                evaluationStoppedEarly = true;
                break;
            }
        }

        // Add 500ms delay between requests to respect API rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Shut down the test server
    server.close();

    const unevaluatedCount = cases.length - (lastEvaluatedIndex + 1) + (evaluationStoppedEarly ? 1 : 0);

    console.log('\n======================================');
    console.log('Evaluation Results');
    console.log('======================================');
    console.log(`Total cases: ${cases.length}`);
    console.log(`Successful model evaluations: ${succeededCount}`);
    console.log(`Model validation failures (HTTP 422): ${modelValidationFailures.length}`);
    console.log(`Provider/API failures: ${providerFailures.length}`);
    if (evaluationStoppedEarly) {
        console.log(`Un-evaluated cases (rate limited): ${unevaluatedCount}`);
        console.log(`[NOTE] The remaining ${unevaluatedCount} cases could not be evaluated due to daily provider rate limits.`);
    }

    console.log('\nAccuracy is calculated only from successfully evaluated cases.');

    if (succeededCount > 0) {
        const catAccuracy = ((correctCategory / succeededCount) * 100).toFixed(1);
        const urgAccuracy = ((correctUrgency / succeededCount) * 100).toFixed(1);
        const avgConf = (totalConfidence / succeededCount).toFixed(2);

        console.log(`Category accuracy: ${catAccuracy}%`);
        console.log(`Urgency accuracy: ${urgAccuracy}%`);
        console.log(`Average confidence: ${avgConf}`);
    } else {
        console.log('Category accuracy: N/A (no successful cases)');
        console.log('Urgency accuracy: N/A (no successful cases)');
        console.log('Average confidence: N/A (no successful cases)');
    }

    if (incorrect.length > 0) {
        console.log('\nIncorrect predictions:');
        incorrect.forEach((item) => {
            console.log(`- Text: "${item.text}"`);
            console.log(`  Expected: category=${item.expectedCategory}, urgency=${item.expectedUrgency}`);
            console.log(`  Predicted: category=${item.predictedCategory}, urgency=${item.predictedUrgency}`);
            console.log(`  Confidence: ${item.confidence}`);
            console.log(`  Reason: "${item.reason}"`);
        });
    } else {
        console.log('\nIncorrect predictions: None');
    }

    if (lowConfidence.length > 0) {
        console.log('\nLow-confidence predictions:');
        lowConfidence.forEach((item) => {
            console.log(`- Text: "${item.text}"`);
            console.log(`  Expected: category=${item.expectedCategory}, urgency=${item.expectedUrgency}`);
            console.log(`  Predicted: category=${item.predictedCategory}, urgency=${item.predictedUrgency}`);
            console.log(`  Confidence: ${item.confidence}`);
            console.log(`  Reason: "${item.reason}"`);
        });
    } else {
        console.log('\nLow-confidence predictions: None');
    }

    // Always exit cleanly (code 0) so evaluation run is reported properly
    process.exit(0);
}

runEvaluation().catch((err) => {
    console.error('Fatal evaluation crash:', err);
    process.exit(1);
});
