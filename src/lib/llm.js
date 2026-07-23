import { openrouterRequestFields } from './llmClientOptions';

export const invokeLLM = async ({ prompt, response_json_schema }) => {
  const response = await fetch('/api/llm/json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      response_json_schema,
      ...openrouterRequestFields(),
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'Failed to invoke local LLM API.');
  }

  return payload.data;
};

/** Plain completion (no JSON parsing). Prefer for prompts that ask for free-form text. */
export const invokeLLMText = async ({
  prompt,
  systemPrompt = '',
  temperature = 0.7,
  max_tokens,
} = {}) => {
  const response = await fetch('/api/llm/text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      systemPrompt,
      temperature,
      ...(max_tokens != null ? { max_tokens } : {}),
      ...openrouterRequestFields(),
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'Failed to invoke local LLM API.');
  }

  return String(payload.text || '').trim();
};
