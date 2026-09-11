import { openDB, type IDBPDatabase } from "idb";
import type { ElementOverrideTable } from "../document/types";
import type { HtmlIdCounts } from "../export/exportDocument";
import type { SerializableEditCommand } from "../history/commandHistory";

export interface RecoveryRecord {
  id: string;
  fileName: string;
  fingerprint: string;
  baselineIdCounts: HtmlIdCounts;
  html: string;
  activeSlide: number;
  overrides: ElementOverrideTable;
  commands: SerializableEditCommand[];
  historyCursor: number;
  exportedAt: number | null;
  updatedAt: number;
}

export interface RecoveryLoadResult {
  recovery: RecoveryRecord | null;
  corruptIds: IDBValidKey[];
}

const DATABASE_NAME = "html-slide-editor";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const UPDATED_AT_INDEX = "updatedAt";
const MAX_SRCDOC_DEPTH = 8;
const MAX_SRCDOC_CHARACTERS = 1_000_000;

const RECOVERY_KEYS = [
  "id",
  "fileName",
  "fingerprint",
  "baselineIdCounts",
  "html",
  "activeSlide",
  "overrides",
  "commands",
  "historyCursor",
  "exportedAt",
  "updatedAt",
] as const;

const COMMAND_KEYS = [
  "id",
  "label",
  "kind",
  "targetId",
  "before",
  "after",
] as const;

const COMMAND_KINDS = new Set<SerializableEditCommand["kind"]>([
  "patch",
  "duplicate-object",
  "delete-object",
  "reorder-slide",
  "duplicate-slide",
  "delete-slide",
]);
const FORBIDDEN_JSON_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

async function openRecoveryDatabase(): Promise<IDBPDatabase> {
  return openDB(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database, _oldVersion, _newVersion, transaction) {
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });

      if (!store.indexNames.contains(UPDATED_AT_INDEX)) {
        store.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX);
      }
    },
  });
}

async function withDatabase<T>(
  operation: (database: IDBPDatabase) => Promise<T>,
): Promise<T> {
  const database = await openRecoveryDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

export async function saveRecovery(record: RecoveryRecord): Promise<void> {
  assertRecoveryRecord(record);
  await withDatabase(async (database) => {
    await database.put(STORE_NAME, record);
  });
}

export async function loadLatestRecovery(
  expectedFingerprint?: string,
): Promise<RecoveryRecord | null> {
  return (
    await loadLatestRecoveryWithDiagnostics(expectedFingerprint)
  ).recovery;
}

export async function loadLatestRecoveryWithDiagnostics(
  expectedFingerprint?: string,
): Promise<RecoveryLoadResult> {
  if (
    expectedFingerprint !== undefined &&
    typeof expectedFingerprint !== "string"
  ) {
    throw new TypeError("Recovery fingerprint must be a string");
  }

  return withDatabase(async (database) => {
    const transaction = database.transaction(STORE_NAME);
    let cursor = await transaction.store.openCursor();
    let recovery: RecoveryRecord | null = null;
    const corruptIds: IDBValidKey[] = [];

    while (cursor) {
      const candidate = parseRecoveryRecord(cursor.value);
      if (!candidate) {
        corruptIds.push(cursor.primaryKey);
      } else if (
        (expectedFingerprint === undefined ||
          candidate.fingerprint === expectedFingerprint) &&
        (recovery === null || candidate.updatedAt > recovery.updatedAt)
      ) {
        recovery = candidate;
      }
      cursor = await cursor.continue();
    }

    await transaction.done;
    corruptIds.sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
    return { recovery, corruptIds };
  });
}

export async function markExported(
  id: IDBValidKey,
  exportedAt = Date.now(),
): Promise<boolean> {
  if (!isTimestamp(exportedAt)) {
    throw new TypeError("Export timestamp must be a non-negative integer");
  }

  return withDatabase(async (database) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const record = parseRecoveryRecord(await transaction.store.get(id));
    if (!record) {
      await transaction.done;
      return false;
    }

    await transaction.store.put({ ...record, exportedAt });
    await transaction.done;
    return true;
  });
}

export async function deleteRecovery(id: IDBValidKey): Promise<void> {
  await withDatabase(async (database) => {
    await database.delete(STORE_NAME, id);
  });
}

function assertRecoveryRecord(value: unknown): asserts value is RecoveryRecord {
  if (!isRecoveryRecord(value)) {
    throw new TypeError("Invalid recovery record");
  }
}

function parseRecoveryRecord(value: unknown): RecoveryRecord | null {
  try {
    return isRecoveryRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!isPlainRecord(value)) {
    return false;
  }

  const properties = getExactEnumerableDataProperties(value, RECOVERY_KEYS);
  if (!properties) return false;

  const {
    id,
    fileName,
    fingerprint,
    baselineIdCounts,
    html,
    activeSlide,
    overrides,
    commands,
    historyCursor,
    exportedAt,
    updatedAt,
  } = properties;

  if (
    typeof id !== "string" ||
    typeof fileName !== "string" ||
    typeof fingerprint !== "string" ||
    !isHtmlIdCounts(baselineIdCounts) ||
    typeof html !== "string" ||
    !isBridgeFreeHtml(html) ||
    !Number.isInteger(activeSlide) ||
    (activeSlide as number) < 1 ||
    !isOverrideTable(overrides) ||
    !Array.isArray(commands) ||
    !isCanonicalArray(commands, isSerializableEditCommand) ||
    !Number.isInteger(historyCursor) ||
    (historyCursor as number) < 0 ||
    (historyCursor as number) > commands.length ||
    (exportedAt !== null && !isTimestamp(exportedAt)) ||
    !isTimestamp(updatedAt)
  ) {
    return false;
  }

  return true;
}

function isHtmlIdCounts(value: unknown): value is HtmlIdCounts {
  if (!isPlainRecord(value) || !hasOnlyEnumerableStringKeys(value)) {
    return false;
  }
  return Object.values(value).every(
    (count) =>
      typeof count === "number" &&
      Number.isInteger(count) &&
      count >= 0,
  );
}

function isSerializableEditCommand(
  value: unknown,
): value is SerializableEditCommand {
  if (!isPlainRecord(value)) {
    return false;
  }

  const properties = getExactEnumerableDataProperties(value, COMMAND_KEYS);
  if (!properties) return false;

  return (
    typeof properties.id === "string" &&
    typeof properties.label === "string" &&
    typeof properties.kind === "string" &&
    COMMAND_KINDS.has(
      properties.kind as SerializableEditCommand["kind"],
    ) &&
    typeof properties.targetId === "string" &&
    isJsonData(properties.before) &&
    isJsonData(properties.after)
  );
}

function isOverrideTable(value: unknown): value is ElementOverrideTable {
  if (!isPlainRecord(value) || !hasOnlyEnumerableStringKeys(value)) {
    return false;
  }

  return Object.values(value).every(
    (properties) =>
      isPlainRecord(properties) &&
      hasOnlyEnumerableStringKeys(properties) &&
      Object.values(properties).every(
        (propertyValue) => typeof propertyValue === "string",
      ),
  );
}

function isJsonData(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }

  if (Array.isArray(value)) {
    return isCanonicalJsonArray(value, ancestors);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  const valid = keys.every((key) => {
    if (
      typeof key !== "string" ||
      FORBIDDEN_JSON_KEYS.has(key)
    ) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      isJsonData(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}

function isCanonicalJsonArray(
  value: unknown[],
  ancestors: Set<object>,
): boolean {
  ancestors.add(value);
  const valid = isCanonicalArray(value, (item) =>
    isJsonData(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function isCanonicalArray(
  value: unknown[],
  validateItem: (item: unknown) => boolean,
): boolean {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const keys = Reflect.ownKeys(value);
  const length =
    lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : null;
  if (
    !lengthDescriptor ||
    lengthDescriptor.enumerable ||
    !("value" in lengthDescriptor) ||
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    keys.length !== length + 1
  ) {
    return false;
  }

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      !validateItem(descriptor.value)
    ) {
      return false;
    }
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getExactEnumerableDataProperties<
  const Keys extends readonly string[],
>(
  value: Record<string, unknown>,
  expectedKeys: Keys,
): { [Key in Keys[number]]: unknown } | null {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    !keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  ) {
    return null;
  }

  const properties = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return null;
    }
    properties[key] = descriptor.value;
  }
  return properties as { [Key in Keys[number]]: unknown };
}

function hasOnlyEnumerableStringKeys(
  value: Record<string, unknown>,
): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
  });
}

function isTimestamp(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isBridgeFreeHtml(html: string): boolean {
  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    return isBridgeFreeTree(document, 0, {
      remainingSrcdocCharacters: MAX_SRCDOC_CHARACTERS,
    });
  } catch {
    return false;
  }
}

function isBridgeFreeTree(
  root: ParentNode,
  srcdocDepth: number,
  budget: { remainingSrcdocCharacters: number },
): boolean {
  if (root.querySelector("[data-hse-editor-bridge]")) {
    return false;
  }

  for (const template of root.querySelectorAll("template")) {
    if (!isBridgeFreeTree(template.content, srcdocDepth, budget)) {
      return false;
    }
  }

  for (const iframe of root.querySelectorAll("iframe[srcdoc]")) {
    const srcdoc = iframe.getAttribute("srcdoc");
    if (srcdoc === null) continue;
    if (
      srcdocDepth >= MAX_SRCDOC_DEPTH ||
      srcdoc.length > budget.remainingSrcdocCharacters
    ) {
      return false;
    }

    budget.remainingSrcdocCharacters -= srcdoc.length;
    const document = new DOMParser().parseFromString(srcdoc, "text/html");
    if (!isBridgeFreeTree(document, srcdocDepth + 1, budget)) {
      return false;
    }
  }

  return true;
}
