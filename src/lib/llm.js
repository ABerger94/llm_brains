import { openrouterRequestFields } from './llmClientOptions';
import { getPipelineExecutionBackend, EXECUTION_BACKEND_BROWSER } from './localPipeline/executionBackend';

export const invokeLLM = async ({ prompt, response_json_schema }) => {
  if (getPipelineExecutionBackend() === EXECUTION_BACKEND_BROWSER) {
    // Mirrors server/index.js's /api/llm/json exactly: prompt-based JSON mode
    // (no real grammar-constrained decoding server-side either), same parser.
    const [{ callLLM }, { parseLlmJsonText }] = await Promise.all([
      import('./localPipeline/browserCallLlm'),
      import('../../server/llmContextBudget.js'),
    ]);
    const jsonSystem = 'You must respond with ONLY valid JSON. No markdown. No commentary. No code fences.';
    const { text } = await callLLM(jsonSystem, String(prompt), { temperature: 0.2 });
    const data = parseLlmJsonText(text);
    if (data == null || typeof data !== 'object') {
      throw new Error('Model did not return valid JSON.');
    }
    return data;
  }

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
  if (getPipelineExecutionBackend() === EXECUTION_BACKEND_BROWSER) {
    const { callLLM } = await import('./localPipeline/browserCallLlm');
    const { text } = await callLLM(systemPrompt, String(prompt), { temperature, max_tokens });
    return String(text || '').trim();
  }

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
