import { describe, expect, it } from "vitest";
import { createMemoryStorage, usableStorage } from "./stores";

describe("createMemoryStorage", () => {
  it("behaves like Storage for the operations the session uses", () => {
    const storage = createMemoryStorage();
    expect(storage.getItem("missing")).toBeNull();
    storage.setItem("a", "1");
    storage.setItem("b", "2");
    expect(storage.getItem("a")).toBe("1");
    expect(storage.length).toBe(2);
    expect(storage.key(0)).toBe("a");
    storage.removeItem("a");
    expect(storage.getItem("a")).toBeNull();
    storage.clear();
    expect(storage.length).toBe(0);
  });
});

describe("usableStorage", () => {
  it("falls back to memory when the browser has no such store", () => {
    const storage = usableStorage(() => undefined);
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
  });

  it("falls back to memory when writing throws, as in private browsing", () => {
    const hostile = {
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as Storage;
    const storage = usableStorage(() => hostile);
    expect(() => storage.setItem("k", "v")).not.toThrow();
    expect(storage.getItem("k")).toBe("v");
  });

  it("uses the real store when it accepts a probe write", () => {
    const real = createMemoryStorage();
    expect(usableStorage(() => real)).toBe(real);
  });
});
