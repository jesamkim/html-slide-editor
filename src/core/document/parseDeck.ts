import type { DeckParseResult } from "./types";

const HTML_SLIDE_STAGE_WIDTH = 1920;
const HTML_SLIDE_STAGE_HEIGHT = 1080;

type DimensionProperty = "width" | "height";
type Specificity = [ids: number, classes: number, types: number];

interface StyleCandidate {
  value: string;
  important: boolean;
  specificity: Specificity;
  sourceOrder: number;
}

type StyleCandidates = Record<DimensionProperty, StyleCandidate[]>;

const splitTopLevel = (value: string, separator = ","): string[] => {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === separator && parentheses === 0 && brackets === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
};

const identifierEnd = (value: string, start: number) => {
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (!/[\w-]/.test(character) && character.charCodeAt(0) < 0x80) break;
    index += 1;
  }
  return index;
};

const blockEnd = (value: string, start: number, open: string, close: string) => {
  let depth = 0;
  let quote = "";

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return value.length;
};

const compareSpecificity = (left: Specificity, right: Specificity) => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const addSpecificity = (left: Specificity, right: Specificity): Specificity => [
  left[0] + right[0],
  left[1] + right[1],
  left[2] + right[2],
];

const maxSelectorListSpecificity = (selectorList: string): Specificity =>
  splitTopLevel(selectorList)
    .map(selectorSpecificity)
    .reduce<Specificity>(
      (highest, current) =>
        compareSpecificity(current, highest) > 0 ? current : highest,
      [0, 0, 0],
    );

function selectorSpecificity(selector: string): Specificity {
  let specificity: Specificity = [0, 0, 0];
  let index = 0;

  while (index < selector.length) {
    const character = selector[index];

    if (character === "#") {
      specificity[0] += 1;
      index = identifierEnd(selector, index + 1);
      continue;
    }

    if (character === ".") {
      specificity[1] += 1;
      index = identifierEnd(selector, index + 1);
      continue;
    }

    if (character === "[") {
      specificity[1] += 1;
      index = blockEnd(selector, index, "[", "]");
      continue;
    }

    if (character === ":") {
      const pseudoElement = selector[index + 1] === ":";
      const nameStart = index + (pseudoElement ? 2 : 1);
      const nameEnd = identifierEnd(selector, nameStart);
      const name = selector.slice(nameStart, nameEnd).toLowerCase();

      if (selector[nameEnd] === "(") {
        const end = blockEnd(selector, nameEnd, "(", ")");
        const argument = selector.slice(nameEnd + 1, end - 1);

        if (pseudoElement) {
          specificity[2] += 1;
        } else if (name === "is" || name === "not" || name === "has") {
          specificity = addSpecificity(
            specificity,
            maxSelectorListSpecificity(argument),
          );
        } else if (name !== "where") {
          specificity[1] += 1;
        }
        index = end;
        continue;
      }

      if (
        pseudoElement ||
        name === "before" ||
        name === "after" ||
        name === "first-line" ||
        name === "first-letter"
      ) {
        specificity[2] += 1;
      } else {
        specificity[1] += 1;
      }
      index = nameEnd;
      continue;
    }

    if (/[a-zA-Z_\u0080-\uFFFF\\]/.test(character)) {
      let end = identifierEnd(selector, index);
      if (selector[end] === "|") {
        end += 1;
        if (selector[end] === "*") {
          index = end + 1;
          continue;
        }
        end = identifierEnd(selector, end);
      }
      specificity[2] += 1;
      index = end;
      continue;
    }

    index += 1;
  }

  return specificity;
}

const matchingSpecificity = (
  selectorList: string,
  stage: HTMLElement,
): Specificity | null => {
  let highest: Specificity | null = null;

  for (const selector of splitTopLevel(selectorList)) {
    try {
      if (!stage.matches(selector)) continue;
    } catch {
      continue;
    }

    const current = selectorSpecificity(selector);
    if (!highest || compareSpecificity(current, highest) > 0) highest = current;
  }

  return highest;
};

const fallbackMediaMatches = (mediaText: string) =>
  splitTopLevel(mediaText).some((query) => {
    let normalized = query.toLowerCase().trim();
    let negated = false;

    if (normalized.startsWith("not ")) {
      negated = true;
      normalized = normalized.slice(4).trim();
    }
    if (normalized.startsWith("only ")) normalized = normalized.slice(5).trim();

    const mediaType = /^(all|screen|print)\b/.exec(normalized)?.[1] ?? "all";
    const matches = mediaType !== "print";
    return negated ? !matches : matches;
  });

const mediaMatchesDesktopScreen = (mediaText: string) => {
  if (!mediaText.trim()) return true;

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return window.matchMedia(mediaText).matches;
    } catch {
      return false;
    }
  }

  return fallbackMediaMatches(mediaText);
};

const collectStyleRules = (
  rules: CSSRuleList,
  stage: HTMLElement,
  candidates: StyleCandidates,
  sourceOrder: { value: number },
) => {
  for (const rule of rules) {
    if ("selectorText" in rule && "style" in rule) {
      const styleRule = rule as CSSStyleRule;
      const order = sourceOrder.value;
      sourceOrder.value += 1;
      const specificity = matchingSpecificity(styleRule.selectorText, stage);
      if (!specificity) continue;

      for (const property of ["width", "height"] as const) {
        const value = styleRule.style.getPropertyValue(property).trim();
        if (!value) continue;

        candidates[property].push({
          value,
          important: styleRule.style.getPropertyPriority(property) === "important",
          specificity,
          sourceOrder: order,
        });
      }
      continue;
    }

    if (
      rule.type === CSSRule.MEDIA_RULE &&
      "conditionText" in rule &&
      "cssRules" in rule &&
      mediaMatchesDesktopScreen(String(rule.conditionText))
    ) {
      collectStyleRules(
        (rule as CSSMediaRule).cssRules,
        stage,
        candidates,
        sourceOrder,
      );
    }
  }
};

const stylesheetStageDimensions = (
  document: Document,
  stage: HTMLElement,
): StyleCandidates => {
  const candidates: StyleCandidates = { width: [], height: [] };
  const sourceOrder = { value: 0 };

  for (const styleElement of document.querySelectorAll<HTMLStyleElement>("style")) {
    if (
      styleElement.hasAttribute("disabled") ||
      styleElement.sheet?.disabled ||
      !mediaMatchesDesktopScreen(styleElement.media)
    ) {
      continue;
    }

    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(styleElement.textContent ?? "");
    } catch {
      continue;
    }
    collectStyleRules(sheet.cssRules, stage, candidates, sourceOrder);
  }

  return candidates;
};

const pixelDimension = (value: string): number | null => {
  const normalized = value.trim();
  if (/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(normalized)) return 0;

  const match = /^(?:\d+(?:\.\d*)?|\.\d+)px$/i.exec(normalized);
  if (!match) return null;

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const compareCascade = (left: StyleCandidate, right: StyleCandidate) => {
  if (left.important !== right.important) return left.important ? 1 : -1;

  const specificity = compareSpecificity(left.specificity, right.specificity);
  return specificity || left.sourceOrder - right.sourceOrder;
};

const resolveDimension = (
  inlineValue: string,
  candidates: StyleCandidate[],
  fallback: number,
) => {
  const inlinePixels = pixelDimension(inlineValue);
  if (inlinePixels !== null) return inlinePixels;

  for (const candidate of [...candidates].sort((left, right) =>
    compareCascade(right, left),
  )) {
    const pixels = pixelDimension(candidate.value);
    if (pixels !== null) return pixels;
  }

  return fallback;
};

export function parseDeckHtml(source: string, fileName: string): DeckParseResult {
  let document: Document;

  try {
    document = new DOMParser().parseFromString(source, "text/html");
  } catch {
    return {
      ok: false,
      code: "INVALID_HTML",
      message: "HTML 문서를 해석할 수 없습니다.",
    };
  }

  const stage = document.querySelector<HTMLElement>("#stage");
  if (!stage) {
    return { ok: false, code: "MISSING_STAGE", message: "#stage 요소가 없습니다." };
  }

  const slides = [...stage.querySelectorAll<HTMLElement>(":scope > .slide")];
  if (slides.length === 0) {
    return { ok: false, code: "NO_SLIDES", message: "편집할 슬라이드가 없습니다." };
  }

  const stylesheetDimensions = stylesheetStageDimensions(document, stage);

  return {
    ok: true,
    document,
    metadata: {
      fileName,
      title: document.title || fileName,
      slideCount: slides.length,
      stageSize: {
        width: resolveDimension(
          stage.style.width,
          stylesheetDimensions.width,
          HTML_SLIDE_STAGE_WIDTH,
        ),
        height: resolveDimension(
          stage.style.height,
          stylesheetDimensions.height,
          HTML_SLIDE_STAGE_HEIGHT,
        ),
      },
      slides: slides.map((slide, index) => ({
        id: `slide-${index + 1}`,
        index,
        sourceId: slide.id || null,
        label: slide.querySelector("h1,h2,h3")?.textContent?.trim() || `Slide ${index + 1}`,
      })),
    },
  };
}
