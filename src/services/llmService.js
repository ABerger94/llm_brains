/**
 * Local LLM service.
 * The browser calls the Express backend, which forwards to LM Studio with LM_API_TOKEN (Bearer).
 */

import { openrouterRequestFields } from '../lib/llmClientOptions';
import { getPipelineExecutionBackend, EXECUTION_BACKEND_BROWSER } from '../lib/localPipeline/executionBackend';

const TEXT_ENDPOINT = '/api/llm/text';
const TEXT_STREAM_ENDPOINT = '/api/llm/text-stream';

export class LLMService {
  constructor() {
    this.baseUrl = TEXT_ENDPOINT;
  }

  /**
   * Main text invocation used by the graph pipeline and the Base44 compatibility shim.
   */
  async InvokeLLM({ prompt, systemPrompt, temperature = 0.7, max_tokens = 1500, top_p = 0.9 }) {
    if (getPipelineExecutionBackend() === EXECUTION_BACKEND_BROWSER) {
      try {
        const { callLLM } = await import('../lib/localPipeline/browserCallLlm');
        const { text } = await callLLM(systemPrompt || '', prompt, { temperature, max_tokens });
        return text || 'No response from model';
      } catch (error) {
        console.error('Browser LLM call failed:', error);
        return `Error: ${error.message}`;
      }
    }
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          systemPrompt,
          temperature,
          max_tokens,
          top_p,
          ...openrouterRequestFields(),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error('Local LLM API error:', payload);
        return `API Error: ${payload.error || 'Unknown error'}`;
      }

      return payload.text || 'No response from API';
    } catch (error) {
      console.error('LLM call failed:', error);
      return `Error: ${error.message}`;
    }
  }

  /**
   * Batch process multiple prompts.
   */
  async InvokeLLMBatch(prompts, { temperature = 0.7, max_tokens = 500 } = {}) {
    const results = [];

    for (const prompt of prompts) {
      const result = await this.InvokeLLM({
        prompt,
        temperature,
        max_tokens,
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Streams tokens via POST /api/llm/text-stream (SSE). Falls back to single-chunk non-streaming if needed.
   */
  async InvokeLLMStream({ prompt, systemPrompt, temperature = 0.7, max_tokens = 1500, onChunk }) {
    if (getPipelineExecutionBackend() === EXECUTION_BACKEND_BROWSER) {
      // No true token streaming for browser execution (avoids the same per-token
      // React re-render churn that used to crash the llm_brains sibling project) —
      // single-chunk fallback, same as when SSE isn't available server-side.
      const text = await this.InvokeLLM({ prompt, systemPrompt, temperature, max_tokens });
      if (text && onChunk) onChunk(text);
      return;
    }
    try {
      const response = await fetch(TEXT_STREAM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemPrompt,
          temperature,
          max_tokens,
          ...openrouterRequestFields(),
        }),
      });

      const ct = response.headers.get('content-type') || '';

      if (!response.ok || !ct.includes('text/event-stream')) {
        const text = await this.InvokeLLM({
          prompt,
          systemPrompt,
          temperature,
          max_tokens,
        });
        if (text && onChunk) onChunk(text);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await this.InvokeLLM({ prompt, systemPrompt, temperature, max_tokens });
        if (text && onChunk) onChunk(text);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const j = JSON.parse(payload);
            if (j.error) throw new Error(j.error);
            if (j.text && onChunk) onChunk(j.text);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    } catch (error) {
      console.error('Stream LLM call failed:', error);
    }
  }
}

export const llmService = new LLMService();
