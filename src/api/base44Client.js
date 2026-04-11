/**
 * Base44 compatibility layer.
 * Keeps legacy imports working while everything runs locally.
 */

import { localStorageService } from '../services/localStorage.js';
import { llmService } from '../services/llmService.js';

export const base44 = {
  entities: {
    LongTermMemory: localStorageService.entities.LongTermMemory,
    BeliefStore: localStorageService.entities.BeliefStore,
    PipelineRun: localStorageService.entities.PipelineRun,
    MindBiography: localStorageService.entities.MindBiography,
    WorldModel: localStorageService.entities.WorldModel,
    CuriosityItem: localStorageService.entities.CuriosityItem,
    GoalItem: localStorageService.entities.GoalItem,
    TemporalEvent: localStorageService.entities.TemporalEvent,
    ScheduledTask: localStorageService.entities.ScheduledTask,
    Dataset: localStorageService.entities.Dataset,
    ExecutionLog: localStorageService.entities.ExecutionLog,
    ConversationMessage: localStorageService.entities.ConversationMessage,
    get(name) {
      return this[name] || localStorageService.entities[name];
    },
  },
  integrations: {
    Core: {
      async InvokeLLM(params) {
        return llmService.InvokeLLM(params);
      },
      async InvokeLLMBatch(prompts, params) {
        return llmService.InvokeLLMBatch(prompts, params);
      },
      async InvokeLLMStream(params) {
        return llmService.InvokeLLMStream(params);
      },
    },
  },
  async init() {
    await localStorageService.init();
    console.log('Base44 compatibility layer initialized locally.');
  },
  async clearAllData() {
    await localStorageService.clear();
    console.log('All local data cleared.');
  },
  async healthCheck() {
    return {
      storageReady: true,
      llmReady: true,
      timestamp: new Date().toISOString(),
    };
  },
};

export default base44;
