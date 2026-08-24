const { z } = require('zod');

// Input schema for POST /triage
const TriageInputSchema = z.object({
    text: z
        .string({ required_error: 'text is required', invalid_type_error: 'text must be a string' })
        .min(1, { message: 'text must be at least 1 character' })
        .max(2000, { message: 'text must not exceed 2000 characters' }),
});

// Output schema for the triage response
const TriageOutputSchema = z.object({
    category: z.enum(['billing', 'bug', 'feature', 'other']),
    urgency: z.enum(['low', 'normal', 'high']),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
});

module.exports = { TriageInputSchema, TriageOutputSchema };
