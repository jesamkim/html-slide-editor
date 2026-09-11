export function isEditableCandidate(element: Element): boolean {
  const blockTags = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "IMG",
    "SVG",
    "VIDEO",
    "FIGURE",
    "BLOCKQUOTE",
    "LI",
    "TABLE",
  ]);
  const excludedTags = ["SCRIPT", "STYLE", "LINK", "META"];
  const ownerWindow = element.ownerDocument.defaultView;

  const tagName = element.tagName.toUpperCase();
  if (excludedTags.includes(tagName)) return false;

  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("data-hse-editor-artifact")
    ) {
      return false;
    }

    if (ownerWindow) {
      const style = ownerWindow.getComputedStyle(current);
      if (style.display === "none") return false;
    }
  }

  if (ownerWindow) {
    const visibility = ownerWindow.getComputedStyle(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
  }

  if (blockTags.has(tagName)) return true;

  const htmlElement =
    ownerWindow?.HTMLElement ??
    (typeof HTMLElement === "undefined" ? null : HTMLElement);
  return Boolean(
    htmlElement &&
      element instanceof htmlElement &&
      (element.children.length > 0 || element.textContent?.trim()),
  );
}

export function scoreEditableCandidate(
  element: Element,
  rect: DOMRectReadOnly,
): number {
  const blockTags = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "IMG",
    "SVG",
    "VIDEO",
    "FIGURE",
    "BLOCKQUOTE",
    "LI",
    "TABLE",
  ]);

  if (!isEditableCandidate(element) || rect.width < 8 || rect.height < 8) {
    return -Infinity;
  }

  const semantic = blockTags.has(element.tagName.toUpperCase()) ? 40 : 0;
  const className =
    typeof element.className === "string"
      ? element.className
      : (element.getAttribute("class") ?? "");
  const classSignal = /(card|panel|group|layout|hero|title|body|copy)/i.test(
    className,
  )
    ? 25
    : 0;
  const area = Math.min((rect.width * rect.height) / 10000, 30);
  return semantic + classSignal + area;
}

export function selectCandidate(
  path: Element[],
  depth: number,
): Element | null {
  const slideBoundaryIndex = path.findIndex((element) =>
    element.classList.contains("slide"),
  );
  const scopedPath =
    slideBoundaryIndex >= 0 ? path.slice(0, slideBoundaryIndex) : path;
  const candidates = scopedPath
    .filter((element) => {
      const tagName = element.tagName.toUpperCase();
      return (
        !element.classList.contains("slide") &&
        element.id !== "stage" &&
        tagName !== "BODY" &&
        tagName !== "HTML"
      );
    })
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        index,
        rect,
        score: scoreEditableCandidate(element, rect),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score));

  const isDuplicateWrapper = (candidate: (typeof candidates)[number]) => {
    const { element, rect, score } = candidate;
    if (element.children.length !== 1) return false;

    const hasOwnText = Array.from(element.childNodes).some(
      (node) => node.nodeType === 3 && Boolean(node.textContent?.trim()),
    );
    if (hasOwnText) return false;

    const area = Math.min((rect.width * rect.height) / 10000, 30);
    if (score > area) return false;

    const child = element.children[0];
    const childCandidate = candidates.find(
      (nested) => nested.element === child,
    );
    if (!childCandidate) return false;

    const childRect = childCandidate.rect;
    return (
      Math.abs(rect.x - childRect.x) <= 1 &&
      Math.abs(rect.y - childRect.y) <= 1 &&
      Math.abs(rect.width - childRect.width) <= 1 &&
      Math.abs(rect.height - childRect.height) <= 1
    );
  };

  const selectable = candidates.filter(
    (candidate) => !isDuplicateWrapper(candidate),
  );
  if (selectable.length === 0) return null;

  const initial = [...selectable].sort(
    (left, right) =>
      right.score - left.score || right.index - left.index,
  )[0];
  const descendants = selectable
    .filter((candidate) => candidate.index < initial.index)
    .sort((left, right) => right.index - left.index);
  const sequence = [initial, ...descendants];
  const normalizedDepth = Number.isFinite(depth)
    ? Math.max(0, Math.trunc(depth))
    : 0;

  return sequence[Math.min(normalizedDepth, sequence.length - 1)].element;
}
