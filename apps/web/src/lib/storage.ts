// Browser storage that never throws.
//
// Private windows, full quotas and disabled storage all make localStorage
// throw. Nothing in Kinko may break because a preference could not be saved,
// so every access goes through here and degrades to "not stored".

const PREFIX = "kinko:";

function area(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Namespaced localStorage access that reports failure instead of throwing. */
export const storage = {
  get(key: string): string | null {
    try {
      return area()?.getItem(PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      const a = area();
      if (!a) return false;
      a.setItem(PREFIX + key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key: string): void {
    try {
      area()?.removeItem(PREFIX + key);
    } catch {
      // Nothing to do: the value was never readable either.
    }
  },
  getJson<T>(key: string, validate: (v: unknown) => v is T): T | null {
    const raw = storage.get(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  setJson(key: string, value: unknown): boolean {
    return storage.set(key, JSON.stringify(value));
  },
};
