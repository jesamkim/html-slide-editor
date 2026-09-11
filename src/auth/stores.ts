export interface AuthStores {
  persistent: Storage;
  transient: Storage;
}

export const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
};

const PROBE_KEY = "html-slide-editor:storage-probe";

export const usableStorage = (pick: () => Storage | undefined): Storage => {
  try {
    const candidate = pick();
    if (!candidate) return createMemoryStorage();
    candidate.setItem(PROBE_KEY, "1");
    candidate.removeItem(PROBE_KEY);
    return candidate;
  } catch {
    return createMemoryStorage();
  }
};

let cached: AuthStores | null = null;

export const authStores = (): AuthStores => {
  cached ??= {
    persistent: usableStorage(() => globalThis.window?.localStorage),
    transient: usableStorage(() => globalThis.window?.sessionStorage),
  };
  return cached;
};

export const resetAuthStores = () => {
  cached = null;
};
