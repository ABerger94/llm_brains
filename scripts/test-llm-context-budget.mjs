/**
 * Pure tests for llmContextBudget (no live LLM).
 */
import assert from 'node:assert/strict';
import {
  splitTextIntoChunks,
  mergeMapBullets,
  extractFirstJsonObject,
  estimatePromptTokens,
} from '../server/llmContextBudget.js';

// splitTextIntoChunks
{
  const a = splitTextIntoChunks('hello', 100);
  assert.equal(a.length, 1);
  assert.equal(a[0], 'hello');
  const long = 'a\n'.repeat(500);
  const parts = splitTextIntoChunks(long, 80);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), long);
}

// mergeMapBullets order + dedup
{
  const m = mergeMapBullets([
    { chunkIndex: 1, bullets: ['b', 'a'] },
    { chunkIndex: 0, bullets: ['a', 'c'] },
  ]);
  assert.deepEqual(m, ['a', 'c', 'b']);
}

// extractFirstJsonObject
{
  const j = extractFirstJsonObject('noise {"chunkIndex":0,"bullets":["x"]} tail');
  assert.ok(j);
  assert.equal(j.chunkIndex, 0);
  assert.deepEqual(j.bullets, ['x']);
}

// estimatePromptTokens monotonic
{
  const t1 = estimatePromptTokens('a', 'b');
  const t2 = estimatePromptTokens('a', 'bb');
  assert.ok(t2 >= t1);
}

console.log('test-llm-context-budget: ok');
