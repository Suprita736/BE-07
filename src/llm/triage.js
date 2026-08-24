const fs = require('fs');
const path = require('path');
const { executeCompletionWithSafeguards } = require('./client');
const { TriageOutputSchema } = require('./schema');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'triage-v1.md');

// Helper to make a completion call using the centralized safeguard wrapper
async function getCompletion(messages) {
  const response = await executeCompletionWithSafeguards({
    model: process.env.LLM_MODEL,
    messages: messages,
    response_format: { type: 'json_object' }
  });
  return response.choices[0]?.message?.content || '';
}

async function triageMessage(userText) {
  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');

  // 1. First LLM Call
  const firstMessages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: userText,
    },
  ];

  let firstResponse = '';
  try {
    firstResponse = await getCompletion(firstMessages);
  } catch (err) {
    // If the first LLM call fails completely (e.g. network), propagate error to route
    throw err;
  }

  // 2. Parse & Validate first response
  let parsedFirst;
  let firstValid = false;
  let firstError = null;

  try {
    parsedFirst = JSON.parse(firstResponse);
    const validationResult = TriageOutputSchema.safeParse(parsedFirst);
    if (validationResult.success) {
      firstValid = true;
      parsedFirst = validationResult.data;
    } else {
      firstError = validationResult.error.message;
    }
  } catch (err) {
    firstError = `JSON parse failed: ${err.message}`;
  }

  // If first attempt is valid, return immediately
  if (firstValid) {
    return { success: true, data: parsedFirst };
  }

  // 3. Exactly ONE Repair Attempt
  const repairSystemPrompt = 
    "You are a helpful assistant. The previous response was invalid. " +
    "Return ONLY valid JSON. Follow the exact required schema. " +
    "Do not add markdown fences. Do not add explanations.";

  const repairUserMessage = 
    `The previous response was:\n${firstResponse}\n\n` +
    `It failed validation with error:\n${firstError}\n\n` +
    `Please correct the response and return valid JSON matching the schema.`;

  const repairMessages = [
    {
      role: 'system',
      content: repairSystemPrompt,
    },
    {
      role: 'user',
      content: repairUserMessage,
    },
  ];

  let repairResponse = '';
  try {
    repairResponse = await getCompletion(repairMessages);
  } catch (err) {
    return {
      success: false,
      rawResponse: firstResponse,
      repairResponse: `Repair LLM call failed: ${err.message}`,
      error: firstError,
    };
  }

  // 4. Parse & Validate repair response
  let parsedRepair;
  let repairValid = false;
  let repairError = null;

  try {
    parsedRepair = JSON.parse(repairResponse);
    const validationResult = TriageOutputSchema.safeParse(parsedRepair);
    if (validationResult.success) {
      repairValid = true;
      parsedRepair = validationResult.data;
    } else {
      repairError = validationResult.error.message;
    }
  } catch (err) {
    repairError = `JSON parse failed on repair: ${err.message}`;
  }

  if (repairValid) {
    return { success: true, data: parsedRepair };
  }

  // If both failed
  return {
    success: false,
    rawResponse: firstResponse,
    repairResponse: repairResponse,
    error: `First attempt failed: ${firstError}. Repair attempt failed: ${repairError}.`,
  };
}

module.exports = { triageMessage };
