// api/_gradingStore.js
export function getStore() {
  if (!globalThis.__gradingStore) {
    globalThis.__gradingStore = new Map();
  }
  return globalThis.__gradingStore;
}
