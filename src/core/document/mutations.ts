export interface DomMutationRecord {
  parentId: string;
  index: number;
  html: string;
}

export interface DomMutationResult<T extends Element = Element> {
  element: T | null;
  before: DomMutationRecord | null;
  after: DomMutationRecord | null;
  persistentIdMap: Record<string, string>;
}

export function applyDomMutationRecord(
  targetId: string,
  record: DomMutationRecord | null,
): Element | null {
  const selector = `[data-hse-id="${CSS.escape(targetId)}"]`;
  const current = document.querySelector(selector);

  if (record === null) {
    if (!current) {
      throw new Error("편집 대상을 찾을 수 없습니다.");
    }
    current.remove();
    return null;
  }

  const parent = document.querySelector(
    `[data-hse-id="${CSS.escape(record.parentId)}"]`,
  );
  if (!parent) {
    throw new Error("부모 요소를 찾을 수 없습니다.");
  }
  if (
    !Number.isInteger(record.index) ||
    record.index < 0 ||
    record.index > parent.children.length
  ) {
    throw new Error("삽입 위치 범위를 벗어났습니다.");
  }

  const template = document.createElement("template");
  template.innerHTML = record.html.trim();
  if (
    template.content.childElementCount !== 1 ||
    template.content.children[0].getAttribute("data-hse-id") !== targetId
  ) {
    throw new Error("DOM mutation record가 올바르지 않습니다.");
  }

  const element =
    current ?? (template.content.firstElementChild!.cloneNode(true) as Element);
  const insertionIndex =
    current?.parentElement === parent &&
    [...parent.children].indexOf(current) < record.index
      ? record.index + 1
      : record.index;
  const anchor = parent.children[insertionIndex] ?? null;
  parent.insertBefore(element, anchor);
  return element;
}

export const requireParent = (element: Element): Element => {
  const parent = element.parentElement;
  if (!parent) {
    throw new Error("요소가 문서에 연결되어 있지 않습니다.");
  }
  return parent;
};

export const childIndex = (parent: Element, element: Element) =>
  [...parent.children].indexOf(element);

export const mutationRecord = (
  element: Element,
  parentId: string,
  index: number,
): DomMutationRecord => ({
  parentId,
  index,
  html: element.outerHTML,
});

export const directSlides = (parent: Element) =>
  [...parent.children].filter((child) => child.classList.contains("slide"));

export const requireSlide = (slide: Element) => {
  const parent = requireParent(slide);
  if (!slide.classList.contains("slide") || !directSlides(parent).includes(slide)) {
    throw new Error("슬라이드 요소가 아닙니다.");
  }
  return parent;
};

export function ensurePersistentId(element: Element): string {
  const existing = element.getAttribute("data-hse-id");
  const ownerDocument = element.ownerDocument;
  const owners = existing
    ? [
        ...ownerDocument.querySelectorAll<HTMLElement>("[data-hse-id]"),
      ].filter((candidate) => candidate.getAttribute("data-hse-id") === existing)
    : [];
  if (
    existing &&
    (owners.length === 0 || (owners.length === 1 && owners[0] === element))
  ) {
    return existing;
  }

  let id = crypto.randomUUID();
  while (
    [...ownerDocument.querySelectorAll<HTMLElement>("[data-hse-id]")].some(
      (candidate) => candidate.getAttribute("data-hse-id") === id,
    )
  ) {
    id = crypto.randomUUID();
  }
  element.setAttribute("data-hse-id", id);
  return id;
}

export function normalizePersistentIds(root: ParentNode): void {
  const elements = [...root.querySelectorAll<HTMLElement>("[data-hse-id]")];
  const seen = new Set<string>();

  for (const element of elements) {
    const id = element.getAttribute("data-hse-id");
    if (id && !seen.has(id)) {
      seen.add(id);
      continue;
    }
    const replacement = ensurePersistentId(element);
    seen.add(replacement);
  }
}

export function cloneWithFreshIdentifiers<T extends Element>(
  source: T,
  persistentIdMap: Record<string, string> = {},
): T {
  const copy = source.cloneNode(true) as T;
  const elements = [copy, ...copy.querySelectorAll("*")];
  const usedPersistentIds = new Set(
    [
      ...source.ownerDocument.querySelectorAll<HTMLElement>("[data-hse-id]"),
    ].map((element) => element.getAttribute("data-hse-id")!),
  );
  const freshPersistentId = () => {
    let id = crypto.randomUUID();
    while (usedPersistentIds.has(id)) id = crypto.randomUUID();
    usedPersistentIds.add(id);
    return id;
  };
  const scopeReplacements = new Map<Element, Map<string, string>>();
  const globalReplacements = new Map<string, string[]>();
  const scopeFor = (element: Element) => element.closest("svg") ?? copy;
  const registerReplacement = (
    scope: Element,
    original: string,
    replacement: string,
  ) => {
    const scoped = scopeReplacements.get(scope) ?? new Map<string, string>();
    if (!scopeReplacements.has(scope)) scopeReplacements.set(scope, scoped);
    if (!scoped.has(original)) scoped.set(original, replacement);

    const global = globalReplacements.get(original) ?? [];
    global.push(replacement);
    globalReplacements.set(original, global);
  };
  const resolveReplacement = (element: Element, id: string) => {
    const scoped = scopeReplacements.get(scopeFor(element))?.get(id);
    if (scoped) return scoped;

    const global = globalReplacements.get(id);
    return global?.length === 1 ? global[0] : null;
  };
  const rewriteTokenReferences = (element: Element, value: string) =>
    value
      .split(/\s+/)
      .map((token) => resolveReplacement(element, token) ?? token)
      .join(" ");
  const rewriteUrlReferences = (element: Element, value: string) =>
    value.replace(
      /url\(\s*(["']?)#([^)'" \t\r\n\f]+)\1\s*\)/g,
      (match, quote: string, id: string) => {
        const replacement = resolveReplacement(element, id);
        return replacement
          ? `url(${quote}#${replacement}${quote})`
          : match;
      },
    );
  const rewriteCss = (style: Element, value: string) => {
    const withUrls = rewriteUrlReferences(style, value);
    const sheet = new CSSStyleSheet();

    try {
      sheet.replaceSync(withUrls);
    } catch {
      return withUrls;
    }

    const rewriteRules = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if ("selectorText" in rule) {
          const styleRule = rule as CSSStyleRule;
          styleRule.selectorText = styleRule.selectorText.replace(
            /#([A-Za-z_][A-Za-z0-9_-]*)/g,
            (match, id: string) => {
              const replacement = resolveReplacement(style, id);
              return replacement ? `#${CSS.escape(replacement)}` : match;
            },
          );
        }
        if ("cssRules" in rule) {
          rewriteRules((rule as CSSGroupingRule).cssRules);
        }
      }
    };

    rewriteRules(sheet.cssRules);
    return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
  };

  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) {
      const freshId = `hse-${crypto.randomUUID()}`;
      registerReplacement(scopeFor(element), id, freshId);
      element.setAttribute("id", freshId);
    }

    const persistentId = element.getAttribute("data-hse-id");
    if (persistentId) {
      const replacement = freshPersistentId();
      persistentIdMap[persistentId] = replacement;
      element.setAttribute("data-hse-id", replacement);
    }
    element.removeAttribute("data-hse-temp-id");
  }

  for (const element of elements) {
    for (const attribute of [
      "aria-controls",
      "aria-describedby",
      "aria-labelledby",
      "aria-owns",
      "headers",
    ]) {
      const value = element.getAttribute(attribute);
      if (value) {
        element.setAttribute(
          attribute,
          rewriteTokenReferences(element, value),
        );
      }
    }

    for (const attribute of [
      "aria-activedescendant",
      "aria-details",
      "aria-errormessage",
      "for",
      "form",
      "list",
    ]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;

      const replacement = resolveReplacement(element, value);
      if (replacement) element.setAttribute(attribute, replacement);
    }

    for (const attribute of ["href", "xlink:href"]) {
      const value = element.getAttribute(attribute);
      if (!value?.startsWith("#")) continue;

      const replacement = resolveReplacement(element, value.slice(1));
      if (replacement) element.setAttribute(attribute, `#${replacement}`);
    }

    for (const attribute of [...element.attributes]) {
      const rewritten = rewriteUrlReferences(element, attribute.value);
      if (rewritten !== attribute.value) {
        element.setAttribute(attribute.name, rewritten);
      }
    }

    if (element.localName.toLowerCase() === "style" && element.textContent) {
      element.textContent = rewriteCss(element, element.textContent);
    }
  }

  if (!copy.getAttribute("data-hse-id")) {
    copy.setAttribute("data-hse-id", freshPersistentId());
  }
  return copy;
}

export function cloneWithFreshIdentifiersAndMap<T extends Element>(
  source: T,
): { element: T; persistentIdMap: Record<string, string> } {
  const persistentIdMap: Record<string, string> = {};
  return {
    element: cloneWithFreshIdentifiers(source, persistentIdMap),
    persistentIdMap,
  };
}

export function duplicateObject<T extends Element>(
  source: T,
): DomMutationResult<T> {
  const parent = requireParent(source);
  const { element: copy, persistentIdMap } =
    cloneWithFreshIdentifiersAndMap(source);
  const parentId = ensurePersistentId(parent);

  source.after(copy);
  return {
    element: copy,
    before: null,
    after: mutationRecord(copy, parentId, childIndex(parent, copy)),
    persistentIdMap,
  };
}

export function deleteObject<T extends Element>(
  target: T,
): DomMutationResult<T> {
  const parent = requireParent(target);
  const index = childIndex(parent, target);
  const html = target.outerHTML;
  const parentId = ensurePersistentId(parent);

  target.remove();
  return {
    element: null,
    before: { parentId, index, html },
    after: null,
    persistentIdMap: {},
  };
}

export function duplicateSlide<T extends Element>(
  source: T,
): DomMutationResult<T> {
  requireSlide(source);
  return duplicateObject(source);
}

export function deleteSlide<T extends Element>(
  target: T,
): DomMutationResult<T> {
  const parent = requireSlide(target);
  if (directSlides(parent).length === 1) {
    throw new Error("마지막 슬라이드는 삭제할 수 없습니다.");
  }
  return deleteObject(target);
}

export function reorderSlide<T extends Element>(
  slide: T,
  newIndex: number,
): DomMutationResult<T> {
  const parent = requireSlide(slide);
  const slides = directSlides(parent);
  const oldIndex = slides.indexOf(slide);

  if (
    !Number.isInteger(newIndex) ||
    newIndex < 0 ||
    newIndex >= slides.length
  ) {
    throw new Error("슬라이드 순서 범위를 벗어났습니다.");
  }

  const html = slide.outerHTML;
  const parentId = ensurePersistentId(parent);
  const before = { parentId, index: childIndex(parent, slide), html };

  if (newIndex < oldIndex) {
    slides[newIndex].before(slide);
  } else if (newIndex > oldIndex) {
    slides[newIndex].after(slide);
  }

  return {
    element: slide,
    before,
    after: { parentId, index: childIndex(parent, slide), html },
    persistentIdMap: {},
  };
}
