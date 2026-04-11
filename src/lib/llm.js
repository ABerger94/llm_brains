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
