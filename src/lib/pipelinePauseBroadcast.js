/**
 * Cross-tab cooperative pause: Dashboard (or any tab) can broadcast so the tab that registered
 * pause tokens will POST /api/pipeline/pause-request for its tokens.
 */
import {
  appendCooperativePauseAllRequestedToExecutionLogs,
  cooperativePauseAnyRequestOk,
} from './pipelinePauseAllExecutionLogs';
import { requestCooperativePauseForAllRegisteredTokens } from './pipelineActiveRunRegistry';

const CHANNEL_NAME = 'yourbrain-cooperative-pause-v1';
const MESSAGE_TYPE = 'cooperative-pause-all';

/** @type {BroadcastChannel | null} */
let channel = null;
let listenerRefCount = 0;

function onChannelMessage(ev) {
  if (ev?.data?.type !== MESSAGE_TYPE) return;
  void (async () => {
    const r = await requestCooperativePauseForAllRegisteredTokens();
    if (cooperativePauseAnyRequestOk(r)) {
      appendCooperativePauseAllRequestedToExecutionLogs();
    }
  })();
}

/**
 * Notify other same-origin tabs to fire cooperative pause for their registered tokens.
 */
export function broadcastCooperativePauseAll() {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.postMessage({ type: MESSAGE_TYPE });
    bc.close();
  } catch {
    /* ignore */
  }
}

/**
 * Listen for {@link broadcastCooperativePauseAll} and pause in this tab when tokens are registered here.
 * Ref-counted for React StrictMode (double mount/unmount).
 * @returns {() => void} cleanup
 */
export function installCooperativePauseBroadcastListener() {
  if (typeof BroadcastChannel === 'undefined') return () => {};

  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = onChannelMessage;
    } catch {
      return () => {};
    }
  }

  listenerRefCount += 1;
  return () => {
    listenerRefCount -= 1;
    if (listenerRefCount <= 0 && channel) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      channel = null;
      listenerRefCount = 0;
    }
  };
}
