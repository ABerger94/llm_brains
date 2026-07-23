"use client";

/**
 * There's no account system, so this anonymous, per-browser id is what
 * namespaces this browser's data in the backend memory store — it's the
 * unit of "whose mind is this," not a real identity. Persisted in
 * localStorage so it survives reloads; a fresh browser/profile starts a
 * fresh mind.
 */

const MIND_ID_KEY = "mindchain.mindId.v1";

export function getOrCreateMindId(): string {
  if (typeof window === "undefined" || !window.localStorage) return "";
  try {
    let id = window.localStorage.getItem(MIND_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(MIND_ID_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}
