import {
  isEditableCandidate,
  scoreEditableCandidate,
  selectCandidate,
} from "../core/document/candidates";
import {
  applyDomMutationRecord,
  childIndex,
  cloneWithFreshIdentifiers,
  cloneWithFreshIdentifiersAndMap,
  deleteObject,
  deleteSlide,
  directSlides,
  duplicateObject,
  duplicateSlide,
  ensurePersistentId,
  mutationRecord,
  normalizePersistentIds,
  reorderSlide,
  requireParent,
  requireSlide,
} from "../core/document/mutations";
import {
  buildOverrideCss,
  cleanupEditorState,
  EDITOR_CLEANUP_MANIFEST,
} from "../core/export/exportDocument";
import { parseDeckHtml } from "../core/document/parseDeck";
import type { ElementOverrideTable } from "../core/document/types";
import {
  ElementOverrideTableSchema,
  SessionTokenSchema,
} from "./protocol";
import { bridgeRuntime } from "./runtime";

const serializeScriptValue = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export interface InjectBridgeOptions {
  initialOverrides?: ElementOverrideTable;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Emits the injected helpers under both the name the source calls them by and
 * the name the bundler gave them.
 *
 * The runtime is shipped as text from `Function.prototype.toString()`, so every
 * helper it calls has to exist as a binding in the injected scope. A minified
 * build renames each binding: the stringified runtime still calls
 * `normalizePersistentIds` while the stringified helper arrives as
 * `function eC(...)` and calls its siblings by their minified names too. Binding
 * both names to the same function keeps every reference resolvable, whichever
 * name a given body happens to use. An unminified build declares one name and
 * skips the alias.
 */
export const declareInjectedHelpers = (
  helpers: Record<string, (...args: never[]) => unknown>,
): string[] => {
  const bound = new Set(Object.keys(helpers));
  const declarations = Object.entries(helpers).map(
    ([name, helper]) => `const ${name} = ${helper.toString()};`,
  );
  const aliases: string[] = [];
  for (const [name, helper] of Object.entries(helpers)) {
    const bundled = helper.name;
    if (
      !bundled ||
      bundled === name ||
      bound.has(bundled) ||
      !IDENTIFIER_PATTERN.test(bundled)
    ) {
      continue;
    }
    bound.add(bundled);
    aliases.push(`const ${bundled} = ${name};`);
  }
  return [...declarations, ...aliases];
};

export function injectBridge(
  source: string,
  token: string,
  options: InjectBridgeOptions = {},
): string {
  const sessionToken = SessionTokenSchema.parse(token);
  const initialOverrides = ElementOverrideTableSchema.parse(
    options.initialOverrides ?? {},
  );
  buildOverrideCss(initialOverrides);
  const parsed = parseDeckHtml(source, "deck.html");
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  const { document } = parsed;
  normalizePersistentIds(document);
  document
    .querySelectorAll("script[data-hse-editor-bridge]")
    .forEach((element) => element.remove());

  const script = document.createElement("script");
  script.setAttribute("data-hse-editor-bridge", "");
  script.textContent = [
    "(() => {",
    ...declareInjectedHelpers({
      isEditableCandidate,
      scoreEditableCandidate,
      selectCandidate,
      requireParent,
      childIndex,
      mutationRecord,
      directSlides,
      requireSlide,
      ensurePersistentId,
      normalizePersistentIds,
      cloneWithFreshIdentifiers,
      cloneWithFreshIdentifiersAndMap,
      duplicateObject,
      deleteObject,
      duplicateSlide,
      deleteSlide,
      reorderSlide,
      applyDomMutationRecord,
      buildOverrideCss,
      cleanupEditorState,
    }),
    `const EDITOR_CLEANUP_MANIFEST = ${serializeScriptValue(
      EDITOR_CLEANUP_MANIFEST,
    )};`,
    `(${bridgeRuntime.toString()})(${serializeScriptValue({
      token: sessionToken,
      initialOverrides,
    })});`,
    "})();",
  ].join("\n");
  document.head.prepend(script);

  const sourceDoctype = source.match(/<!doctype[^>]*>/i)?.[0] ?? "";
  const serialized = document.documentElement.outerHTML;
  return sourceDoctype ? `${sourceDoctype}\n${serialized}` : serialized;
}
