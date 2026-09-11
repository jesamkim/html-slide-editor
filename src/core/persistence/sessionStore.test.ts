import "fake-indexeddb/auto";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecoveryRecord } from "./sessionStore";
import {
  deleteRecovery,
  loadLatestRecovery,
  loadLatestRecoveryWithDiagnostics,
  markExported,
  saveRecovery,
} from "./sessionStore";

const DATABASE_NAME = "html-slide-editor";
const STORE_NAME = "sessions";

function recovery(
  overrides: Partial<RecoveryRecord> = {},
): RecoveryRecord {
  return {
    id: "session-1",
    fileName: "deck.html",
    fingerprint: "fingerprint-a",
    baselineIdCounts: { intro: 1 },
    html: "<!doctype html><html><body><main id=\"stage\"></main></body></html>",
    activeSlide: 1,
    overrides: {
      "node-1": {
        color: "rgb(255, 0, 0)",
      },
    },
    commands: [
      {
        id: "command-1",
        label: "Move object",
        kind: "patch",
        targetId: "node-1",
        before: { translateX: 0, translateY: 0 },
        after: { translateX: 10, translateY: 5 },
      },
    ],
    historyCursor: 1,
    exportedAt: null,
    updatedAt: 100,
    ...overrides,
  };
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to delete test database")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("Test database deletion was blocked")),
    );
  });
}

async function putRawRecord(record: unknown): Promise<void> {
  const database = await openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    },
  });
  try {
    await database.put(STORE_NAME, record);
  } finally {
    database.close();
  }
}

async function getRawRecord(id: IDBValidKey): Promise<unknown> {
  const database = await openDB(DATABASE_NAME, 1);
  try {
    return await database.get(STORE_NAME, id);
  } finally {
    database.close();
  }
}

const invalidJsonArrayCases = [
  {
    name: "sparse array",
    create() {
      const value = new Array<unknown>(2);
      value[1] = "present";
      return { value, accessorReads: () => 0 };
    },
  },
  {
    name: "custom string property",
    create() {
      const value: unknown[] = ["item"];
      Object.defineProperty(value, "extra", {
        configurable: true,
        enumerable: true,
        value: "unexpected",
        writable: true,
      });
      return { value, accessorReads: () => 0 };
    },
  },
  {
    name: "symbol property",
    create() {
      const value: unknown[] = ["item"];
      Object.defineProperty(value, Symbol("extra"), {
        configurable: true,
        enumerable: true,
        value: "unexpected",
        writable: true,
      });
      return { value, accessorReads: () => 0 };
    },
  },
  {
    name: "accessor index",
    create() {
      let reads = 0;
      const value: unknown[] = ["item"];
      Object.defineProperty(value, "0", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return "computed";
        },
      });
      return { value, accessorReads: () => reads };
    },
  },
] as const;

const invalidCommandsArrayCases = [
  {
    name: "sparse array",
    create() {
      const commands = new Array<RecoveryRecord["commands"][number]>(1);
      return { commands, accessorReads: () => 0 };
    },
  },
  {
    name: "custom string property",
    create() {
      const commands = [recovery().commands[0]];
      Object.defineProperty(commands, "extra", {
        configurable: true,
        enumerable: true,
        value: "unexpected",
        writable: true,
      });
      return { commands, accessorReads: () => 0 };
    },
  },
  {
    name: "symbol property",
    create() {
      const commands = [recovery().commands[0]];
      Object.defineProperty(commands, Symbol("extra"), {
        configurable: true,
        enumerable: true,
        value: "unexpected",
        writable: true,
      });
      return { commands, accessorReads: () => 0 };
    },
  },
  {
    name: "accessor index",
    create() {
      let reads = 0;
      const commands = [recovery().commands[0]];
      Object.defineProperty(commands, "0", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return recovery().commands[0];
        },
      });
      return { commands, accessorReads: () => reads };
    },
  },
] as const;

const invalidRequiredDescriptorCases = [
  {
    name: "non-enumerable recovery field",
    create() {
      const record = recovery();
      Object.defineProperty(record, "fileName", {
        configurable: true,
        enumerable: false,
        value: "deck.html",
        writable: true,
      });
      return { record, accessorReads: () => 0 };
    },
  },
  {
    name: "recovery field accessor",
    create() {
      let reads = 0;
      const record = recovery();
      Object.defineProperty(record, "fileName", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return "deck.html";
        },
      });
      return { record, accessorReads: () => reads };
    },
  },
  {
    name: "non-enumerable command field",
    create() {
      const command = { ...recovery().commands[0] };
      Object.defineProperty(command, "targetId", {
        configurable: true,
        enumerable: false,
        value: "node-1",
        writable: true,
      });
      return {
        record: recovery({ commands: [command] }),
        accessorReads: () => 0,
      };
    },
  },
  {
    name: "command field accessor",
    create() {
      let reads = 0;
      const command = { ...recovery().commands[0] };
      Object.defineProperty(command, "targetId", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return "node-1";
        },
      });
      return {
        record: recovery({ commands: [command] }),
        accessorReads: () => reads,
      };
    },
  },
] as const;

function encodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function wrapInSrcdoc(value: string): string {
  return `<iframe srcdoc="${encodeHtmlAttribute(value)}"></iframe>`;
}

const bridgeHtmlCases = [
  {
    name: "direct marker",
    html: "<html><body><script data-hse-editor-bridge></script></body></html>",
  },
  {
    name: "mixed-case marker",
    html: "<html><body><script DATA-HSE-EDITOR-BRIDGE></script></body></html>",
  },
  {
    name: "template marker",
    html: "<html><body><template><script data-hse-editor-bridge></script></template></body></html>",
  },
  {
    name: "raw srcdoc marker",
    html: "<html><body><iframe srcdoc='<script data-hse-editor-bridge></script>'></iframe></body></html>",
  },
  {
    name: "entity-encoded srcdoc marker",
    html: "<html><body><iframe srcdoc=\"&lt;script data-hse-editor-bridge&gt;&lt;/script&gt;\"></iframe></body></html>",
  },
  {
    name: "recursively nested srcdoc marker",
    html: `<html><body>${wrapInSrcdoc(
      wrapInSrcdoc("<script data-hse-editor-bridge></script>"),
    )}</body></html>`,
  },
] as const;

const forbiddenCommandJsonCases = [
  {
    name: "__proto__",
    value: JSON.parse(
      "{\"__proto__\":{\"polluted\":true}}",
    ) as unknown,
  },
  {
    name: "constructor",
    value: JSON.parse(
      "{\"nested\":{\"constructor\":{\"polluted\":true}}}",
    ) as unknown,
  },
  {
    name: "prototype",
    value: JSON.parse(
      "{\"items\":[{\"prototype\":{\"polluted\":true}}]}",
    ) as unknown,
  },
] as const;

describe("recovery persistence", () => {
  beforeEach(deleteDatabase);
  afterEach(deleteDatabase);

  it("saves and restores the newest valid session", async () => {
    await saveRecovery(recovery({ id: "older", updatedAt: 100 }));
    await saveRecovery(
      recovery({
        id: "newer",
        activeSlide: 3,
        updatedAt: 200,
      }),
    );

    expect(await loadLatestRecovery()).toMatchObject({
      id: "newer",
      activeSlide: 3,
      updatedAt: 200,
    });
  });

  it("persists and validates immutable imported baseline id counts", async () => {
    const record = recovery({
      baselineIdCounts: {
        clip: 2,
        shape: 2,
      },
    });

    await saveRecovery(record);

    await expect(loadLatestRecovery()).resolves.toMatchObject({
      baselineIdCounts: {
        clip: 2,
        shape: 2,
      },
    });
  });

  it.each([
    { clip: -1 },
    { clip: 1.5 },
    { clip: Number.NaN },
    { clip: "2" },
  ])("rejects malformed imported baseline counts %#", async (baselineIdCounts) => {
    await expect(
      saveRecovery(
        recovery({
          baselineIdCounts: baselineIdCounts as never,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("returns the newest valid record matching the requested fingerprint", async () => {
    await saveRecovery(
      recovery({
        id: "matching",
        fingerprint: "fingerprint-a",
        updatedAt: 100,
      }),
    );
    await saveRecovery(
      recovery({
        id: "other-file",
        fingerprint: "fingerprint-b",
        updatedAt: 200,
      }),
    );

    expect(await loadLatestRecovery("fingerprint-a")).toMatchObject({
      id: "matching",
      fingerprint: "fingerprint-a",
    });
    expect(await loadLatestRecovery("fingerprint-c")).toBeNull();
  });

  it("saves JSON arrays containing nested arrays and objects", async () => {
    const record = recovery({
      commands: [
        {
          ...recovery().commands[0],
          before: [],
          after: [
            null,
            true,
            42,
            "text",
            ["nested", { values: [1, 2, 3] }],
            { child: { items: [] } },
          ],
        },
      ],
    });

    await saveRecovery(record);

    expect(await loadLatestRecovery()).toEqual(record);
  });

  it.each(invalidJsonArrayCases)(
    "rejects a JSON $name without storing or invoking accessors",
    async ({ create }) => {
      const { value, accessorReads } = create();
      const record = recovery({
        commands: [
          {
            ...recovery().commands[0],
            after: value,
          },
        ],
      });

      await expect(saveRecovery(record)).rejects.toThrow(TypeError);
      expect(accessorReads()).toBe(0);
      expect(await loadLatestRecovery()).toBeNull();
      expect(await getRawRecord(record.id)).toBeUndefined();
    },
  );

  it.each(invalidCommandsArrayCases)(
    "rejects a top-level commands $name without storing or invoking accessors",
    async ({ create, name }) => {
      const { commands, accessorReads } = create();
      const id = `commands-${name}`;
      const record = recovery({ id, commands });

      await expect(saveRecovery(record)).rejects.toThrow(TypeError);
      expect(accessorReads()).toBe(0);
      expect(await loadLatestRecovery()).toBeNull();
      expect(await getRawRecord(id)).toBeUndefined();
    },
  );

  it.each(invalidRequiredDescriptorCases)(
    "rejects a $name without storing or invoking accessors",
    async ({ create }) => {
      const { record, accessorReads } = create();

      await expect(saveRecovery(record)).rejects.toThrow(TypeError);
      expect(accessorReads()).toBe(0);
      expect(await loadLatestRecovery()).toBeNull();
      expect(await getRawRecord(record.id)).toBeUndefined();
    },
  );

  it.each(bridgeHtmlCases)(
    "rejects a $name before save and after untyped persistence",
    async ({ name, html }) => {
      const id = `bridge-${name}`;
      const record = recovery({ id, html });

      await expect(saveRecovery(record)).rejects.toThrow(TypeError);
      expect(await loadLatestRecovery()).toBeNull();
      expect(await getRawRecord(id)).toBeUndefined();

      await putRawRecord(record);
      expect(await loadLatestRecoveryWithDiagnostics()).toEqual({
        recovery: null,
        corruptIds: [id],
      });
    },
  );

  it("rejects srcdoc nesting beyond the recursion guard", async () => {
    let nested = "<p>safe</p>";
    for (let depth = 0; depth < 12; depth += 1) {
      nested = wrapInSrcdoc(nested);
    }
    const record = recovery({
      id: "srcdoc-depth",
      html: `<html><body>${nested}</body></html>`,
    });

    await expect(saveRecovery(record)).rejects.toThrow(TypeError);
    expect(await loadLatestRecovery()).toBeNull();
    expect(await getRawRecord(record.id)).toBeUndefined();

    await putRawRecord(record);
    expect(await loadLatestRecoveryWithDiagnostics()).toEqual({
      recovery: null,
      corruptIds: [record.id],
    });
  });

  it("rejects srcdoc content beyond the parsing size guard", async () => {
    const record = recovery({
      id: "srcdoc-size",
      html: `<html><body><iframe srcdoc="${"a".repeat(
        1_100_000,
      )}"></iframe></body></html>`,
    });

    await expect(saveRecovery(record)).rejects.toThrow(TypeError);
    expect(await loadLatestRecovery()).toBeNull();
    expect(await getRawRecord(record.id)).toBeUndefined();

    await putRawRecord(record);
    expect(await loadLatestRecoveryWithDiagnostics()).toEqual({
      recovery: null,
      corruptIds: [record.id],
    });
  });

  it.each(forbiddenCommandJsonCases)(
    "rejects the recursively forbidden JSON key $name",
    async ({ name, value }) => {
      const id = `forbidden-${name}`;
      const record = recovery({
        id,
        commands: [
          {
            ...recovery().commands[0],
            after: value,
          },
        ],
      });

      await expect(saveRecovery(record)).rejects.toThrow(TypeError);
      expect(await loadLatestRecovery()).toBeNull();
      expect(await getRawRecord(id)).toBeUndefined();

      await putRawRecord(record);
      expect(await loadLatestRecoveryWithDiagnostics()).toEqual({
        recovery: null,
        corruptIds: [id],
      });
    },
  );

  it("skips a corrupt newest record without deleting any session", async () => {
    await saveRecovery(recovery({ id: "valid", updatedAt: 100 }));
    await putRawRecord({
      ...recovery({ id: "corrupt", updatedAt: 200 }),
      activeSlide: 0,
    });

    const result = await loadLatestRecoveryWithDiagnostics();

    expect(result.recovery).toMatchObject({ id: "valid" });
    expect(result.corruptIds).toEqual(["corrupt"]);
    expect(await getRawRecord("corrupt")).toMatchObject({
      id: "corrupt",
      activeSlide: 0,
    });
    expect(await getRawRecord("valid")).toMatchObject({ id: "valid" });
  });

  it("returns null and corrupt IDs when no persisted record is valid", async () => {
    const malformedRecords: unknown[] = [
      {
        ...recovery({ id: "extra-field", updatedAt: 101 }),
        unexpected: true,
      },
      {
        ...recovery({ id: "command-kind", updatedAt: 102 }),
        commands: [
          {
            ...recovery().commands[0],
            kind: "unknown-command",
          },
        ],
      },
      {
        ...recovery({ id: "command-string", updatedAt: 103 }),
        commands: [
          {
            ...recovery().commands[0],
            targetId: 42,
          },
        ],
      },
      {
        ...recovery({ id: "command-json", updatedAt: 104 }),
        commands: [
          {
            ...recovery().commands[0],
            after: new Date(0),
          },
        ],
      },
      {
        ...recovery({ id: "override-value", updatedAt: 105 }),
        overrides: {
          "node-1": {
            color: 42,
          },
        },
      },
      {
        ...recovery({ id: "cursor", updatedAt: 106 }),
        historyCursor: 2,
      },
      {
        ...recovery({ id: "active-slide", updatedAt: 107 }),
        activeSlide: 1.5,
      },
      {
        ...recovery({ id: "exported-at", updatedAt: 108 }),
        exportedAt: -1,
      },
      {
        ...recovery({ id: "updated-at" }),
        updatedAt: "yesterday",
      },
      {
        ...recovery({ id: "bridge-html", updatedAt: 109 }),
        html: "<html><body><script data-hse-editor-bridge></script></body></html>",
      },
    ];
    for (const record of malformedRecords) {
      await putRawRecord(record);
    }

    const result = await loadLatestRecoveryWithDiagnostics();

    expect(result.recovery).toBeNull();
    expect(result.corruptIds).toEqual([
      "active-slide",
      "bridge-html",
      "command-json",
      "command-kind",
      "command-string",
      "cursor",
      "exported-at",
      "extra-field",
      "override-value",
      "updated-at",
    ]);
  });

  it.each([
    ["extra record field", { unexpected: true }],
    ["cursor outside command list", { historyCursor: 2 }],
    ["zero active slide", { activeSlide: 0 }],
    ["negative timestamp", { updatedAt: -1 }],
    [
      "bridge-bearing HTML",
      {
        html: "<html><body><script data-hse-editor-bridge></script></body></html>",
      },
    ],
  ])("rejects %s before saving", async (_name, patch) => {
    const invalid = {
      ...recovery(),
      ...patch,
    } as RecoveryRecord;

    await expect(saveRecovery(invalid)).rejects.toThrow(TypeError);
    expect(await loadLatestRecovery()).toBeNull();
  });

  it("marks an export timestamp without changing the remaining record", async () => {
    const original = recovery();
    await saveRecovery(original);

    await expect(markExported(original.id, 250)).resolves.toBe(true);

    expect(await loadLatestRecovery("fingerprint-a")).toEqual({
      ...original,
      exportedAt: 250,
    });
  });

  it("deletes only the targeted recovery record", async () => {
    await saveRecovery(recovery({ id: "keep", updatedAt: 100 }));
    await putRawRecord({
      ...recovery({ id: "discard", updatedAt: 200 }),
      activeSlide: 0,
    });

    const { corruptIds } = await loadLatestRecoveryWithDiagnostics();
    await deleteRecovery(corruptIds[0]);

    expect(await getRawRecord("discard")).toBeUndefined();
    expect(await loadLatestRecovery()).toMatchObject({ id: "keep" });
  });

  it("creates the schema on first use and reopens it idempotently", async () => {
    await saveRecovery(recovery({ id: "first", updatedAt: 100 }));
    await saveRecovery(recovery({ id: "second", updatedAt: 200 }));

    const database = await openDB(DATABASE_NAME, 1);
    try {
      expect([...database.objectStoreNames]).toEqual([STORE_NAME]);
      const transaction = database.transaction(STORE_NAME);
      expect([...transaction.store.indexNames]).toEqual(["updatedAt"]);
      await transaction.done;
    } finally {
      database.close();
    }
    expect(await loadLatestRecovery()).toMatchObject({ id: "second" });
  });
});
