import type { ElementOverrideTable } from "../document/types";

export interface ExportValidationResult {
  ok: boolean;
  errors: string[];
}

export type HtmlIdCounts = Record<string, number>;

export const EDITOR_CLEANUP_MANIFEST = {
  removeSelectors: [
    "[data-hse-editor-bridge]",
    "[data-hse-editor-artifact]",
    "style#hse-live-overrides",
  ],
  removeAttributes: [
    "data-hse-temp-id",
    "data-hse-build-step-origin",
    "contenteditable",
    "data-hse-selected",
  ],
  removeAttributePrefixes: ["data-hse-selection"],
  runtimeClasses: [
    { selector: ".slide", classes: ["active", "entered"] },
    { selector: "[data-step]", classes: ["revealed"] },
  ],
} as const;

export function cleanupEditorState(
  root: ParentNode,
  manifest: {
    removeSelectors: readonly string[];
    removeAttributes: readonly string[];
    removeAttributePrefixes: readonly string[];
    runtimeClasses: readonly {
      selector: string;
      classes: readonly string[];
    }[];
  } = EDITOR_CLEANUP_MANIFEST,
): void {
  for (const selector of manifest.removeSelectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }

  root.querySelectorAll("*").forEach((element) => {
    for (const attribute of manifest.removeAttributes) {
      element.removeAttribute(attribute);
    }
    for (const attribute of [...element.attributes]) {
      if (
        manifest.removeAttributePrefixes.some((prefix) =>
          attribute.name.startsWith(prefix),
        )
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  for (const runtime of manifest.runtimeClasses) {
    root.querySelectorAll(runtime.selector).forEach((element) => {
      element.classList.remove(...runtime.classes);
      if (element.getAttribute("class") === "") {
        element.removeAttribute("class");
      }
    });
  }
}

export function countHtmlIds(document: Document): HtmlIdCounts {
  const counts = Object.create(null) as HtmlIdCounts;
  document.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
    counts[element.id] = (counts[element.id] ?? 0) + 1;
  });
  return counts;
}

export function buildOverrideCss(overrides: ElementOverrideTable): string {
  const supportedProperties = new Set([
    "color",
    "font-size",
    "font-weight",
    "height",
    "text-align",
    "translate",
    "width",
  ]);
  const unsafeContextPattern =
    /[;{}<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  const commentPattern = /\/\*|\*\//;
  const blocks: string[] = [];

  for (const id of Object.keys(overrides).sort()) {
    if (!id || /[\u0000-\u001f\u007f]/.test(id)) {
      throw new Error("안전하지 않은 CSS override입니다.");
    }

    const declarations: string[] = [];
    for (const property of Object.keys(overrides[id]).sort()) {
      const value = overrides[id][property].trim();
      if (!value) continue;

      if (
        !supportedProperties.has(property) ||
        unsafeContextPattern.test(value) ||
        commentPattern.test(value)
      ) {
        throw new Error("안전하지 않은 CSS override입니다.");
      }

      const style = document.createElement("div").style;
      style.setProperty(property, value);
      const canonicalValue = style.getPropertyValue(property).trim();
      if (
        style.length !== 1 ||
        style.item(0) !== property ||
        !canonicalValue
      ) {
        throw new Error("안전하지 않은 CSS override입니다.");
      }

      declarations.push(
        `  ${CSS.escape(property)}: ${canonicalValue};`,
      );
    }

    if (declarations.length === 0) continue;
    blocks.push(
      [
        `[data-hse-id="${CSS.escape(id)}"] {`,
        ...declarations,
        "}",
      ].join("\n"),
    );
  }

  return blocks.join("\n");
}

export function prepareExport(
  source: Document,
  options: { overrides: ElementOverrideTable },
): string {
  const document = source.cloneNode(true) as Document;
  cleanupEditorState(document);

  const css = buildOverrideCss(options.overrides);
  if (css) {
    document
      .querySelectorAll("style#hse-overrides[data-hse-editor-overrides]")
      .forEach((node) => node.remove());
    const style = document.createElement("style");
    style.id = "hse-overrides";
    style.setAttribute("data-hse-editor-overrides", "");
    style.textContent = css;
    document.head.append(style);
  }

  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}

export function validateExport(
  html: string,
  baselineIdCounts: HtmlIdCounts,
): ExportValidationResult {
  const document = new DOMParser().parseFromString(html, "text/html");
  const errors: string[] = [];

  if (document.querySelector("[data-hse-editor-bridge]")) {
    errors.push("편집기 브리지 마커가 남아 있습니다.");
  }
  if (document.querySelector("[data-hse-editor-artifact]")) {
    errors.push("편집기 artifact가 남아 있습니다.");
  }
  if (document.querySelector("#hse-live-overrides")) {
    errors.push("실시간 override 스타일이 남아 있습니다.");
  }
  if (document.querySelector("[data-hse-temp-id]")) {
    errors.push("임시 편집기 ID가 남아 있습니다.");
  }
  if (document.querySelector("[contenteditable]")) {
    errors.push("contenteditable 상태가 남아 있습니다.");
  }
  const hasSelectionState = [...document.querySelectorAll("*")].some(
    (element) =>
      [...element.attributes].some(
        (attribute) =>
          attribute.name === "data-hse-selected" ||
          attribute.name.startsWith("data-hse-selection"),
      ),
  );
  if (hasSelectionState) {
    errors.push("선택 상태가 남아 있습니다.");
  }
  if (
    document.querySelector(
      ".slide.active,.slide.entered,[data-step].revealed",
    )
  ) {
    errors.push("런타임 클래스가 남아 있습니다.");
  }

  const currentIdCounts = countHtmlIds(document);
  for (const id of Object.keys(currentIdCounts).sort()) {
    const current = currentIdCounts[id];
    const baseline = Object.prototype.hasOwnProperty.call(
      baselineIdCounts,
      id,
    )
      ? baselineIdCounts[id]
      : 0;
    if (current > 1 && current > baseline) {
      errors.push(
        `중복 HTML id가 증가했습니다: ${id} (${baseline} -> ${current})`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
