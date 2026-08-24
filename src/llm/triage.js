const fs = require('fs');
const path = require('path');
const client = require('./client');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'triage-v1.md');

async function triageMessage(userText) {
  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');

  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userText,
      },
    ],
    response_format: { type: 'json_object' }
  });

  return response.choices[0]?.message?.content || '';
}

module.exports = { triageMessage };
