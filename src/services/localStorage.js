/**
 * Mind entity persistence via IndexedDB (replaces legacy localStorage arrays).
 */

import {
  idbPutRecord,
  idbDeleteRecord,
  isValidIndexedDbRecordKey,
  idbGetRecordValue,
  idbGetAllForEntityType,
  idbDeleteAllForEntityType,
  idbCountByEntityType,
} from '../lib/browserStorage.js';

/** Isolated IndexedDB entity types for dual-graph playground System B (mirror mind). */
export const PLAYGROUND_MIRROR_ENTITY_SUFFIX = '__playground_mirror';

function mirrorType(base) {
  return `${base}${PLAYGROUND_MIRROR_ENTITY_SUFFIX}`;
}

class LocalStorageService {
  constructor() {
    this.entities = {
      LongTermMemory: new EntityManager('LongTermMemory'),
      BeliefStore: new EntityManager('BeliefStore'),
      PipelineRun: new EntityManager('PipelineRun'),
      MindBiography: new EntityManager('MindBiography'),
      WorldModel: new EntityManager('WorldModel'),
      CuriosityItem: new EntityManager('CuriosityItem'),
      GoalItem: new EntityManager('GoalItem'),
      TemporalEvent: new EntityManager('TemporalEvent'),
      ScheduledTask: new EntityManager('ScheduledTask'),
      Dataset: new EntityManager('Dataset'),
      ExecutionLog: new EntityManager('ExecutionLog'),
      ConversationMessage: new EntityManager('ConversationMessage'),
      FeedbackItem: new EntityManager('FeedbackItem'),
      TrainingRun: new EntityManager('TrainingRun'),
      DreamRun: new EntityManager('DreamRun'),
      EmergenceEvent: new EntityManager('EmergenceEvent'),
      SelfLedgerRevision: new EntityManager('SelfLedgerRevision'),
      BeliefTension: new EntityManager('BeliefTension'),
      UserModelSnapshot: new EntityManager('UserModelSnapshot'),
      ConsolidationDigest: new EntityManager('ConsolidationDigest'),
      PendingMindUpdate: new EntityManager('PendingMindUpdate'),
    };
    this.entitiesMirror = {
      LongTermMemory: new EntityManager(mirrorType('LongTermMemory')),
      BeliefStore: new EntityManager(mirrorType('BeliefStore')),
      PipelineRun: new EntityManager(mirrorType('PipelineRun')),
      MindBiography: new EntityManager(mirrorType('MindBiography')),
      WorldModel: new EntityManager(mirrorType('WorldModel')),
      CuriosityItem: new EntityManager(mirrorType('CuriosityItem')),
      GoalItem: new EntityManager(mirrorType('GoalItem')),
      TemporalEvent: new EntityManager(mirrorType('TemporalEvent')),
      ConversationMessage: new EntityManager(mirrorType('ConversationMessage')),
      EmergenceEvent: new EntityManager(mirrorType('EmergenceEvent')),
      SelfLedgerRevision: new EntityManager(mirrorType('SelfLedgerRevision')),
      BeliefTension: new EntityManager(mirrorType('BeliefTension')),
      UserModelSnapshot: new EntityManager(mirrorType('UserModelSnapshot')),
      ConsolidationDigest: new EntityManager(mirrorType('ConsolidationDigest')),
      FeedbackItem: new EntityManager(mirrorType('FeedbackItem')),
      DreamRun: new EntityManager(mirrorType('DreamRun')),
      PendingMindUpdate: new EntityManager(mirrorType('PendingMindUpdate')),
    };
  }

  async init() {
    console.log('✅ Mind entity storage (IndexedDB) initialized');
  }

  async clear() {
    const primary = Object.values(this.entities).map((m) => m.entityName);
    const mirror = Object.values(this.entitiesMirror).map((m) => m.entityName);
    await Promise.all([...primary, ...mirror].map((entityType) => idbDeleteAllForEntityType(entityType)));
  }
}

class EntityManager {
  constructor(entityName) {
    this.entityName = entityName;
  }

  generateUid() {
    return `${this.entityName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async create(data) {
    const safeData = data && typeof data === 'object' ? { ...data } : {};
    delete safeData.id;
    delete safeData.created_date;
    const record = {
      ...safeData,
      id: this.generateUid(),
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
    };

    await idbPutRecord({
      id: record.id,
      entityType: this.entityName,
      value: record,
    });

    return record;
  }

  async update(id, data) {
    const cur = await idbGetRecordValue(id);
    if (!cur) return null;

    const safeData = data && typeof data === 'object' ? { ...data } : {};
    delete safeData.id;
    const next = {
      ...cur,
      ...safeData,
      id,
      updated_date: new Date().toISOString(),
    };

    await idbPutRecord({
      id,
      entityType: this.entityName,
      value: next,
    });
    return next;
  }

  async retrieve(id) {
    const v = await idbGetRecordValue(id);
    return v || null;
  }

  /** Row count for this entity type (indexed; does not load rows). */
  async count() {
    return idbCountByEntityType(this.entityName);
  }

  async list(sortOrder = '-created_date', limit = 100) {
    let records = await idbGetAllForEntityType(this.entityName);

    if (sortOrder) {
      const isDesc = sortOrder.startsWith('-');
      const field = sortOrder.replace(/^-/, '');
      records.sort((a, b) => {
        if (a[field] < b[field]) return isDesc ? 1 : -1;
        if (a[field] > b[field]) return isDesc ? -1 : 1;
        return 0;
      });
    }

    return records.slice(0, limit);
  }

  /** All rows for this entity type, optionally sorted (no limit). */
  async listAll(sortOrder = '-created_date') {
    let records = await idbGetAllForEntityType(this.entityName);

    if (sortOrder) {
      const isDesc = sortOrder.startsWith('-');
      const field = sortOrder.replace(/^-/, '');
      records.sort((a, b) => {
        if (a[field] < b[field]) return isDesc ? 1 : -1;
        if (a[field] > b[field]) return isDesc ? -1 : 1;
        return 0;
      });
    }

    return records;
  }

  async filter(criteria = {}, sortOrder = '-created_date', limit = 100) {
    let records = await idbGetAllForEntityType(this.entityName);

    for (const [key, value] of Object.entries(criteria)) {
      records = records.filter((r) => r[key] === value);
    }

    if (sortOrder) {
      const isDesc = sortOrder.startsWith('-');
      const field = sortOrder.replace(/^-/, '');
      records.sort((a, b) => {
        if (a[field] < b[field]) return isDesc ? 1 : -1;
        if (a[field] > b[field]) return isDesc ? -1 : 1;
        return 0;
      });
    }

    return records.slice(0, limit);
  }

  async delete(id) {
    if (!isValidIndexedDbRecordKey(id)) {
      console.warn(`[${this.entityName}] delete skipped: invalid id`, id);
      return false;
    }
    const ok = await idbDeleteRecord(id);
    return Boolean(ok);
  }

  async deleteAll() {
    await idbDeleteAllForEntityType(this.entityName);
    return true;
  }
}

export const localStorageService = new LocalStorageService();
