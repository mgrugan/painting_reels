/**
 * Direct browser access to the Messages API.
 *
 * The request goes from this tab straight to api.anthropic.com. There is no
 * server in between, which is why `anthropic-dangerous-direct-browser-access`
 * is required: it tells the API to answer a CORS preflight from a page. The
 * trade-off is the usual one for that header — whoever can open this page with
 * a key can spend it, so the key belongs to the person running the dashboard.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

/** Prices in dollars per million tokens, for the on-screen cost estimate. */
export const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/** Haiku predates the effort parameter and rejects it. */
const SUPPORTS_EFFORT = new Set(['claude-opus-5', 'claude-sonnet-5']);

export class AnthropicError extends Error {
  constructor(message, { status, type, retryable } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.type = type;
    this.retryable = Boolean(retryable);
  }
}

async function post(apiKey, body, signal) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new AnthropicError(
      'Could not reach api.anthropic.com. Check the network connection, and any ' +
        'extension or proxy that might be blocking the request.',
      { retryable: true },
    );
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the status-based message below */
  }

  if (!res.ok) {
    const detail = json?.error?.message || text.slice(0, 300) || res.statusText;
    throw new AnthropicError(detail, {
      status: res.status,
      type: json?.error?.type,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  return json;
}

/**
 * One structured-output call.
 *
 * `schema` is a JSON Schema the response is constrained to. Older models
 * without structured-output support fall back to plain JSON in a text block,
 * which we parse defensively.
 */
export async function generateJson({
  apiKey,
  model,
  system,
  content,
  schema,
  effort = 'high',
  maxTokens = 8000,
  signal,
}) {
  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
  };
  if (SUPPORTS_EFFORT.has(model)) base.output_config = { effort };

  const withSchema = {
    ...base,
    output_config: {
      ...(base.output_config || {}),
      format: { type: 'json_schema', schema },
    },
  };

  let response;
  try {
    response = await post(apiKey, withSchema, signal);
  } catch (err) {
    // A model or account without structured outputs rejects `format` with a 400.
    // Retry once, asking for JSON in the prompt instead.
    const noFormat = err instanceof AnthropicError && err.status === 400;
    if (!noFormat) throw err;
    response = await post(
      apiKey,
      {
        ...base,
        system: `${system}\n\nRespond with a single JSON object matching this schema and nothing else:\n${JSON.stringify(schema)}`,
      },
      signal,
    );
  }

  if (response?.stop_reason === 'refusal') {
    throw new AnthropicError(
      'The model declined this request. Try a different painting or a different voice.',
      { type: 'refusal' },
    );
  }

  const text = (response?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return { data: parseJson(text), usage: response?.usage || {}, model: response?.model || model };
}

/** Pulls the JSON object out of a response that may be fenced or prefaced. */
function parseJson(text) {
  const trimmed = (text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* keep going */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* keep going */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* keep going */
    }
  }
  throw new AnthropicError('The model did not return usable JSON. Try again.');
}

/** Cheapest possible round-trip, used by the "Test key" button. */
export async function testKey(apiKey, model, signal) {
  await post(
    apiKey,
    { model, max_tokens: 4, messages: [{ role: 'user', content: 'ok' }] },
    signal,
  );
  return true;
}

export function estimateCost(model, inTokens, outTokens) {
  const price = PRICING[model];
  if (!price) return null;
  return (inTokens / 1e6) * price.in + (outTokens / 1e6) * price.out;
}
