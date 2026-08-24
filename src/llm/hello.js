require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
});

async function main() {
    try {
        const response = await client.chat.completions.create({
            model: process.env.LLM_MODEL,
            messages: [
                {
                    role: 'user',
                    content: 'Reply with exactly one word: ready',
                },
            ],
        });

        console.log(response.choices[0]?.message?.content);
    } catch (error) {
        console.error('LLM request failed:', error.message);
    }
}

main();