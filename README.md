# AI Triage API (`ai-triage-api`)

Backend AI Engineering (BE-07) - Automated support message classification service.

## Setup & Installation

### Installation
```bash
npm install
```

### Environment Variables
Configure the following in your `.env` file (see `.env.example` for reference):
- `LLM_BASE_URL`: The base URL of the OpenAI-compatible API provider (e.g. `https://openrouter.ai/api/v1`).
- `LLM_API_KEY`: Your provider API key.
- `LLM_MODEL`: The LLM model identifier (e.g. `openrouter/free`).
- `LLM_ENABLED`: Kill switch (`true` or `false`).
- `LLM_STUB`: Stub mode flag (`1` to enable local stubs, `0` for real LLM requests).
- `LLM_TIMEOUT_MS`: Request timeout limit in milliseconds (default: `30000`).
- `LLM_MAX_RETRIES`: Number of retry attempts on transient network or API errors (default: `2`).
- `LLM_RETRY_BASE_MS`: Base delay in milliseconds for exponential backoff (default: `250`).

### Running the Server
- **Development Mode** (with Nodemon):
  ```bash
  npm run dev
  ```
- **Production Mode**:
  ```bash
  npm start
  ```

---

## API Documentation

### Health Check
- **Endpoint:** `GET /`
- **Response:**
  ```json
  {
    "status": "ok",
    "message": "AI Triage API is running"
  }
  ```

### Triage Endpoint
- **Endpoint:** `POST /triage`
- **Request Headers:** `Content-Type: application/json`
- **Request Body Example:**
  ```json
  {
    "text": "My invoice shows two charges for the same subscription."
  }
  ```
- **Response Example (HTTP 200):**
  ```json
  {
    "category": "billing",
    "urgency": "normal",
    "confidence": 0.95,
    "reason": "The customer reports a duplicate subscription charge."
  }
  ```

- **Error Responses:**
  - **HTTP 400 (Bad Request):** Missing or invalid input field.
  - **HTTP 422 (Unprocessable Entity):** Unable to produce a valid schema-compliant response after repair attempts.
  - **HTTP 503 (Service Unavailable):** AI service is disabled.

---

## Feature Details

### LLM_STUB (Stub Mode)
When `LLM_STUB=1`, the API does not call the real LLM provider. Instead, it returns a deterministic stub response which is still passed through the exact same output Zod validation schema before being returned to ensure validation pipelines are executed.

### LLM_ENABLED (Kill Switch)
When `LLM_ENABLED=false`, all LLM requests are blocked. The `/triage` endpoint immediately returns `HTTP 503 Service Unavailable` with:
```json
{
  "error": "AI service is currently disabled"
}
```

---

## Evaluation Suite

A built-in evaluation suite allows testing system performance across defined categories (billing, bug, feature, other) and ambiguous inputs.

### Running the Evaluation
Ensure `LLM_STUB=0` and a valid `LLM_API_KEY` is configured in your `.env`. Then execute:
```bash
node eval/run.js
```

### What the Evaluation Measures
- **Accuracy:** The percentage of correctly classified categories and urgency levels against expectations (calculated only from successfully evaluated cases, excluding any provider/API transient failures from the denominator).
- **Confidence:** Average confidence score returned by the LLM.
- **Failures:** Identifies incorrect predictions, low-confidence responses, and model parsing failures.
- **Quarantine Check:** Ensures failures are logged to `logs/quarantine.jsonl` and return `HTTP 422`.
