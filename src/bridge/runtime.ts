declare function isEditableCandidate(element: Element): boolean;
declare function selectCandidate(
  path: Element[],
  depth: number,
): Element | null;
declare function ensurePersistentId(element: Element): string;
declare function normalizePersistentIds(root: ParentNode): void;
declare function cloneWithFreshIdentifiersAndMap<T extends Element>(
  source: T,
): { element: T; persistentIdMap: Record<string, string> };
declare function duplicateObject<T extends Element>(
  source: T,
): {
  element: T | null;
  before: { parentId: string; index: number; html: string } | null;
  after: { parentId: string; index: number; html: string } | null;
  persistentIdMap: Record<string, string>;
};
declare function deleteObject<T extends Element>(
  target: T,
): ReturnType<typeof duplicateObject<T>>;
declare function duplicateSlide<T extends Element>(
  source: T,
): ReturnType<typeof duplicateObject<T>>;
declare function deleteSlide<T extends Element>(
  target: T,
): ReturnType<typeof duplicateObject<T>>;
declare function reorderSlide<T extends Element>(
  slide: T,
  newIndex: number,
): ReturnType<typeof duplicateObject<T>>;
declare function applyDomMutationRecord(
  targetId: string,
  record: { parentId: string; index: number; html: string } | null,
): Element | null;
declare function buildOverrideCss(
  overrides: Record<string, Record<string, string>>,
): string;
declare const EDITOR_CLEANUP_MANIFEST: {
  removeSelectors: readonly string[];
  removeAttributes: readonly string[];
  removeAttributePrefixes: readonly string[];
  runtimeClasses: readonly {
    selector: string;
    classes: readonly string[];
  }[];
};
declare function cleanupEditorState(
  root: ParentNode,
  manifest?: typeof EDITOR_CLEANUP_MANIFEST,
): void;

type RuntimePatch = {
  translateX?: number;
  translateY?: number;
  width?: number;
  height?: number | "auto";
  text?: string;
  fontSize?: string;
  color?: string;
  fontWeight?: string;
  textAlign?: "left" | "center" | "right";
};

type RuntimeCommand = {
  id: string;
  label: string;
  kind:
    | "patch"
    | "duplicate-object"
    | "delete-object"
    | "reorder-slide"
    | "duplicate-slide"
    | "delete-slide";
  targetId: string;
  before: unknown;
  after: unknown;
};

type RuntimePatchState = {
  override: Record<string, string> | null;
  text?: string;
};

type RuntimeStructuralState = {
  dom: { parentId: string; index: number; html: string } | null;
  overrideDelta: Record<string, Record<string, string> | null>;
};

export function bridgeRuntime(config: {
  token: string;
  initialOverrides: Record<string, Record<string, string>>;
}): void {
  const capture = true;
  const navigationKeys = new Set([
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ]);
  const textTags = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "LI",
    "TABLE",
  ]);
  const inlineTextTags = new Set([
    "SPAN",
    "STRONG",
    "EM",
    "B",
    "I",
    "SMALL",
    "LABEL",
    "TD",
    "TH",
  ]);
  const patchKeys = new Set([
    "translateX",
    "translateY",
    "width",
    "height",
    "text",
    "fontSize",
    "color",
    "fontWeight",
    "textAlign",
  ]);
  let currentDepth = 0;
  let currentPath: Element[] = [];
  let currentSelection: Element | null = null;
  let idSequence = 0;
  let initialized = false;
  let elementIds = new WeakMap<Element, string>();
  let temporaryIds = new Map<string, Element>();
  let persistentIds = new Map<string, Element>();
  let buildStepObserver: MutationObserver | null = null;
  const mutationAcks = new Map<string, Record<string, unknown>>();
  let overrides: Record<string, Record<string, string>> = JSON.parse(
    JSON.stringify(config.initialOverrides),
  );
  let editing:
    | {
        element: HTMLElement;
        originalHtml: string;
        originalText: string;
        targetId: string;
      }
    | null = null;

  const send = (message: Record<string, unknown>) => {
    window.parent.postMessage({ ...message, token: config.token }, "*");
  };

  const directDeckSlides = () => {
    const stage = document.querySelector("#stage");
    return stage
      ? [...stage.children].filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            child.classList.contains("slide"),
        )
      : [];
  };

  const deckSlideFor = (element: Element | null) => {
    if (!element) return null;
    const slides = directDeckSlides();
    return (
      slides.find(
        (slide) => slide === element || slide.contains(element),
      ) ?? null
    );
  };

  const buildStepOriginAttribute = "data-hse-build-step-origin";

  const revealBuildStep = (element: Element) => {
    if (!element.hasAttribute(buildStepOriginAttribute)) {
      element.setAttribute(
        buildStepOriginAttribute,
        element.classList.contains("revealed") ? "revealed" : "hidden",
      );
    }
    if (!element.classList.contains("revealed")) {
      element.classList.add("revealed");
    }
  };

  const revealBuildStepsIn = (root: ParentNode) => {
    if (root instanceof Element && root.matches("[data-step]")) {
      revealBuildStep(root);
    }
    root.querySelectorAll("[data-step]").forEach(revealBuildStep);
  };

  const restoreBuildStep = (element: Element) => {
    const origin = element.getAttribute(buildStepOriginAttribute);
    if (origin === null) return;
    element.classList.toggle("revealed", origin === "revealed");
    element.removeAttribute(buildStepOriginAttribute);
  };

  const startBuildStepReveal = () => {
    buildStepObserver?.disconnect();
    revealBuildStepsIn(document);
    buildStepObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          if (
            record.attributeName === "data-step" &&
            !record.target.hasAttribute("data-step")
          ) {
            restoreBuildStep(record.target);
          } else if (record.target.matches("[data-step]")) {
            revealBuildStep(record.target);
          }
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) revealBuildStepsIn(node);
        }
      }
    });
    buildStepObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-step"],
      childList: true,
      subtree: true,
    });
  };

  const stopBuildStepReveal = () => {
    buildStepObserver?.disconnect();
    buildStepObserver = null;
    document
      .querySelectorAll(`[${buildStepOriginAttribute}]`)
      .forEach(restoreBuildStep);
  };

  const randomId = () => {
    idSequence += 1;
    const suffix = idSequence.toString(36);
    if (typeof window.crypto?.randomUUID === "function") {
      let id = `hse-${window.crypto.randomUUID()}-${suffix}`;
      while (temporaryIds.has(id) || persistentIds.has(id)) {
        id = `hse-${window.crypto.randomUUID()}-${suffix}`;
      }
      return id;
    }

    return `hse-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}-${suffix}`;
  };

  const idFor = (element: Element) => {
    const persistent = element.getAttribute("data-hse-id");
    if (persistent && persistentIds.get(persistent) === element) {
      return persistent;
    }
    if (persistent) {
      const normalized = ensurePersistentId(element);
      persistentIds.set(normalized, element);
      return normalized;
    }

    const existing = elementIds.get(element);
    if (existing) return existing;

    const id = randomId();
    elementIds.set(element, id);
    temporaryIds.set(id, element);
    element.setAttribute("data-hse-temp-id", id);
    return id;
  };

  const targetFor = (targetId: string) =>
    persistentIds.get(targetId) ?? temporaryIds.get(targetId) ?? null;

  const describeElement = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = [...element.classList]
      .map((className) => `.${className}`)
      .join("");
    return `${tag}${id}${classes}`;
  };

  const kindFor = (element: Element) => {
    const tagName = element.tagName.toUpperCase();
    if (tagName === "IMG" || tagName === "VIDEO") return "image";
    if (tagName === "SVG") return "svg";
    if (
      textTags.has(tagName) ||
      inlineTextTags.has(tagName) ||
      (element.children.length === 0 && Boolean(element.textContent?.trim()))
    ) {
      return "text";
    }
    return "container";
  };

  const selectionPath = (path: Element[]) => {
    const deckSlide = deckSlideFor(path[0] ?? null);
    const slideIndex = deckSlide ? path.indexOf(deckSlide) : -1;
    const scoped = slideIndex >= 0 ? path.slice(0, slideIndex + 1) : path;
    return [...scoped].reverse().map(describeElement);
  };

  const pathFor = (element: Element) => {
    const path: Element[] = [];
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      path.push(current);
      if (directDeckSlides().includes(current as HTMLElement)) break;
    }
    return path;
  };

  type RuntimeBounds = Pick<
    DOMRectReadOnly,
    "x" | "y" | "width" | "height"
  >;

  const logicalBounds = (bounds: DOMRectReadOnly): RuntimeBounds => {
    const stage = document.querySelector<HTMLElement>("#stage");
    if (!stage) {
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }

    const stageBounds = stage.getBoundingClientRect();
    const logicalWidth = stage.offsetWidth || stageBounds.width;
    const logicalHeight = stage.offsetHeight || stageBounds.height;
    const scaleX = stageBounds.width / logicalWidth;
    const scaleY = stageBounds.height / logicalHeight;
    if (
      !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) ||
      scaleX <= 0 ||
      scaleY <= 0
    ) {
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }

    return {
      x: (bounds.x - stageBounds.x) / scaleX,
      y: (bounds.y - stageBounds.y) / scaleY,
      width: bounds.width / scaleX,
      height: bounds.height / scaleY,
    };
  };

  const snapTargetsFor = (selected: Element) => {
    const targets: Array<{
      axis: "x" | "y";
      value: number;
      kind: string;
    }> = [];
    const addBounds = (
      bounds: RuntimeBounds,
      kindPrefix: "stage" | "object",
    ) => {
      targets.push(
        { axis: "x", value: bounds.x, kind: `${kindPrefix}-start` },
        {
          axis: "x",
          value: bounds.x + bounds.width / 2,
          kind: `${kindPrefix}-center`,
        },
        {
          axis: "x",
          value: bounds.x + bounds.width,
          kind: `${kindPrefix}-end`,
        },
        { axis: "y", value: bounds.y, kind: `${kindPrefix}-start` },
        {
          axis: "y",
          value: bounds.y + bounds.height / 2,
          kind: `${kindPrefix}-center`,
        },
        {
          axis: "y",
          value: bounds.y + bounds.height,
          kind: `${kindPrefix}-end`,
        },
      );
    };
    const stage = document.querySelector("#stage");
    if (stage) addBounds(logicalBounds(stage.getBoundingClientRect()), "stage");
    const slide = deckSlideFor(selected);
    if (slide) {
      for (const candidate of slide.querySelectorAll("*")) {
        if (
          candidate === selected ||
          candidate.contains(selected) ||
          selected.contains(candidate) ||
          !isEditableCandidate(candidate)
        ) {
          continue;
        }
        const bounds = logicalBounds(candidate.getBoundingClientRect());
        if (bounds.width >= 8 && bounds.height >= 8) {
          addBounds(bounds, "object");
        }
      }
    }
    return targets;
  };

  const selectionSnapshotFor = (
    selected: Element,
    path = pathFor(selected),
  ) => {
    const targetId = idFor(selected);
    const bounds = logicalBounds(selected.getBoundingClientRect());
    const kind = kindFor(selected);
    const computed = window.getComputedStyle(selected);
    return {
      targetId,
      path: selectionPath(path),
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      kind,
      transform: {
        translateX: currentTranslation(targetId).x,
        translateY: currentTranslation(targetId).y,
      },
      snapTargets: snapTargetsFor(selected),
      text: kind === "text" ? selected.textContent ?? "" : null,
      styles:
        kind === "text"
          ? {
              fontSize: computed.fontSize,
              color: computed.color,
              fontWeight: computed.fontWeight,
              textAlign:
                computed.textAlign === "center" ||
                computed.textAlign === "right"
                  ? computed.textAlign
                  : "left",
            }
          : null,
    };
  };

  const setCurrentSelection = (
    selected: Element | null,
    path = selected ? pathFor(selected) : [],
  ) => {
    currentSelection = selected;
    currentPath = path;
  };

  const sendSelectionFor = (selected: Element, path = pathFor(selected)) => {
    setCurrentSelection(selected, path);
    send({
      type: "hse:selection",
      ...selectionSnapshotFor(selected, path),
    });
  };

  const sendSelection = (path: Element[]) => {
    const selected = selectCandidate(path, currentDepth);
    if (selected) sendSelectionFor(selected, path);
  };

  const elementPath = (event: Event) =>
    event
      .composedPath()
      .filter((entry): entry is Element => entry instanceof Element);

  const nearestTextElement = (path: Element[]) => {
    const semantic = path.find(
      (element) =>
        deckSlideFor(element) &&
        isEditableCandidate(element) &&
        textTags.has(element.tagName.toUpperCase()),
    );
    if (semantic) return semantic;
    return (
      path.find(
        (element) =>
          deckSlideFor(element) &&
          isEditableCandidate(element) &&
          element.children.length === 0 &&
          Boolean(element.textContent?.trim()),
      ) ?? null
    );
  };

  const stopDeckInput = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const stopDeckPropagation = (event: Event) => {
    event.stopImmediatePropagation();
  };

  const initialize = () => {
    if (initialized) return true;
    if (
      document.readyState === "loading" &&
      !document.querySelector("#stage")
    ) {
      return false;
    }

    initialized = true;
    normalizePersistentIds(document);
    persistentIds = new Map(
      [...document.querySelectorAll<HTMLElement>("[data-hse-id]")].map(
        (element) => [element.getAttribute("data-hse-id")!, element],
      ),
    );
    document.querySelectorAll("[data-hse-temp-id]").forEach((element) => {
      element.removeAttribute("data-hse-temp-id");
    });
    startBuildStepReveal();
    renderOverrides(overrides);
    send({
      type: "hse:ready",
      slideCount: directDeckSlides().length,
    });
    return true;
  };

  const renderOverrides = (
    nextOverrides: Record<string, Record<string, string>>,
  ) => {
    const css = buildOverrideCss(nextOverrides);
    let style = document.querySelector<HTMLStyleElement>(
      "style#hse-live-overrides",
    );
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "hse-live-overrides";
      document.head.append(style);
    }
    style.textContent = css;
  };

  const cloneOverrides = () =>
    JSON.parse(JSON.stringify(overrides)) as Record<
      string,
      Record<string, string>
    >;

  const registerPersistentSubtree = (element: Element) => {
    for (const candidate of [
      element,
      ...element.querySelectorAll<HTMLElement>("[data-hse-id]"),
    ]) {
      const id = candidate.getAttribute("data-hse-id");
      if (id) persistentIds.set(id, candidate);
    }
  };

  const copyOverrideDelta = (persistentIdMap: Record<string, string>) => {
    const delta: Record<string, Record<string, string>> = {};
    for (const [sourceId, copiedId] of Object.entries(persistentIdMap)) {
      if (Object.prototype.hasOwnProperty.call(overrides, sourceId)) {
        delta[copiedId] = { ...overrides[sourceId] };
      }
    }
    return delta;
  };

  const applyOverrideDelta = (
    delta: Record<string, Record<string, string> | null>,
  ) => {
    const nextOverrides = cloneOverrides();
    for (const [id, value] of Object.entries(delta)) {
      if (value === null) delete nextOverrides[id];
      else nextOverrides[id] = { ...value };
    }
    buildOverrideCss(nextOverrides);
    overrides = nextOverrides;
    renderOverrides(overrides);
  };

  const structuralState = (
    dom: RuntimeStructuralState["dom"],
    overrideDelta: RuntimeStructuralState["overrideDelta"],
  ): RuntimeStructuralState => ({ dom, overrideDelta });

  const freshPersistentId = () => {
    let id = window.crypto.randomUUID();
    while (persistentIds.has(id) || temporaryIds.has(id)) {
      id = window.crypto.randomUUID();
    }
    return id;
  };

  const validatePatch = (patch: unknown): RuntimePatch => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("편집 patch가 올바르지 않습니다.");
    }
    const values = patch as Record<string, unknown>;
    if (Object.keys(values).some((key) => !patchKeys.has(key))) {
      throw new Error("지원하지 않는 편집 patch입니다.");
    }
    for (const key of ["translateX", "translateY"] as const) {
      if (
        values[key] !== undefined &&
        (typeof values[key] !== "number" ||
          !Number.isFinite(values[key]))
      ) {
        throw new Error("좌표 patch가 올바르지 않습니다.");
      }
    }
    for (const key of ["width"] as const) {
      if (
        values[key] !== undefined &&
        (typeof values[key] !== "number" ||
          !Number.isFinite(values[key]) ||
          values[key] < 0)
      ) {
        throw new Error("크기 patch가 올바르지 않습니다.");
      }
    }
    if (
      values.height !== undefined &&
      values.height !== "auto" &&
      (typeof values.height !== "number" ||
        !Number.isFinite(values.height) ||
        values.height < 0)
    ) {
      throw new Error("크기 patch가 올바르지 않습니다.");
    }
    for (const key of [
      "text",
      "fontSize",
      "color",
      "fontWeight",
    ] as const) {
      if (values[key] !== undefined && typeof values[key] !== "string") {
        throw new Error("텍스트 patch가 올바르지 않습니다.");
      }
    }
    if (
      values.textAlign !== undefined &&
      !["left", "center", "right"].includes(
        String(values.textAlign),
      )
    ) {
      throw new Error("정렬 patch가 올바르지 않습니다.");
    }
    return { ...values } as RuntimePatch;
  };

  const currentTranslation = (targetId: string) => {
    const translate = overrides[targetId]?.translate ?? "";
    const matched = translate.match(
      /^(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?$/,
    );
    return {
      x: matched ? Number(matched[1]) : 0,
      y: matched?.[2] ? Number(matched[2]) : 0,
    };
  };

  const applyPatchRequest = (
    target: Element,
    inputPatch: unknown,
  ): {
    before: RuntimePatchState;
    after: RuntimePatchState;
    targetId: string;
  } => {
    const patch = validatePatch(inputPatch);
    const existingId = target.getAttribute("data-hse-id");
    const targetId =
      existingId && persistentIds.get(existingId) === target
        ? existingId
        : freshPersistentId();
    const previousText = target.textContent ?? "";
    const nextOverrides = cloneOverrides();
    const previousOverride = Object.prototype.hasOwnProperty.call(
      nextOverrides,
      targetId,
    )
      ? { ...nextOverrides[targetId] }
      : null;
    const declarations = {
      ...(nextOverrides[targetId] ?? {}),
    };
    const translation = currentTranslation(targetId);

    if (
      patch.translateX !== undefined ||
      patch.translateY !== undefined
    ) {
      declarations.translate = `${
        patch.translateX ?? translation.x
      }px ${patch.translateY ?? translation.y}px`;
    }
    if (patch.width !== undefined) {
      declarations.width = `${patch.width}px`;
    }
    if (patch.height !== undefined) {
      declarations.height =
        patch.height === "auto" ? "auto" : `${patch.height}px`;
    }
    if (patch.fontSize !== undefined) {
      declarations["font-size"] = patch.fontSize;
    }
    if (patch.color !== undefined) declarations.color = patch.color;
    if (patch.fontWeight !== undefined) {
      declarations["font-weight"] = patch.fontWeight;
    }
    if (patch.textAlign !== undefined) {
      declarations["text-align"] = patch.textAlign;
    }
    if (Object.keys(declarations).length > 0) {
      nextOverrides[targetId] = declarations;
    } else {
      delete nextOverrides[targetId];
    }

    buildOverrideCss(nextOverrides);

    if (existingId !== targetId) {
      target.setAttribute("data-hse-id", targetId);
      if (existingId) persistentIds.delete(existingId);
      const temporaryId = target.getAttribute("data-hse-temp-id");
      if (temporaryId) temporaryIds.delete(temporaryId);
      target.removeAttribute("data-hse-temp-id");
    }
    persistentIds.set(targetId, target);
    if (patch.text !== undefined) target.textContent = patch.text;
    overrides = nextOverrides;
    renderOverrides(overrides);
    return {
      before: {
        override: previousOverride,
        ...(patch.text !== undefined ? { text: previousText } : {}),
      },
      after: {
        override: Object.prototype.hasOwnProperty.call(
          nextOverrides,
          targetId,
        )
          ? { ...nextOverrides[targetId] }
          : null,
        ...(patch.text !== undefined ? { text: patch.text } : {}),
      },
      targetId,
    };
  };

  const applyPatchState = (
    target: Element,
    descriptor: unknown,
  ): void => {
    if (!descriptor || typeof descriptor !== "object") {
      throw new Error("히스토리 patch가 올바르지 않습니다.");
    }
    const state = descriptor as RuntimePatchState;
    if (
      state.override !== null &&
      (typeof state.override !== "object" || Array.isArray(state.override))
    ) {
      throw new Error("히스토리 override가 올바르지 않습니다.");
    }
    const targetId = ensurePersistentId(target);
    const nextOverrides = cloneOverrides();
    if (state.override === null) delete nextOverrides[targetId];
    else nextOverrides[targetId] = { ...state.override };
    buildOverrideCss(nextOverrides);

    persistentIds.set(targetId, target);
    if (state.text !== undefined) target.textContent = state.text;
    overrides = nextOverrides;
    renderOverrides(overrides);
  };

  const slideAt = (index: number) => {
    const slides = directDeckSlides();
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      throw new Error("슬라이드 순서 범위를 벗어났습니다.");
    }
    return slides[index];
  };

  const slideIndexFor = (element: Element | null) => {
    const slide = deckSlideFor(element);
    return slide ? directDeckSlides().indexOf(slide) : -1;
  };

  const activateSlide = (
    index: number,
    selection: Element | null,
  ): number => {
    const slides = directDeckSlides();
    if (slides.length === 0) {
      setCurrentSelection(null);
      return 0;
    }
    const normalized = Math.min(Math.max(0, index), slides.length - 1);
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("active", slideIndex === normalized);
    });
    try {
      window.history.replaceState(null, "", `#${normalized + 1}`);
    } catch {
      window.location.hash = String(normalized + 1);
    }
    if (
      selection &&
      deckSlideFor(selection) === slides[normalized] &&
      selection !== slides[normalized]
    ) {
      setCurrentSelection(selection);
    } else {
      setCurrentSelection(null);
    }
    return normalized;
  };

  const currentSlideIndex = () => {
    const slides = directDeckSlides();
    if (slides.length === 0) return 0;
    const activeIndex = slides.findIndex((slide) =>
      slide.classList.contains("active"),
    );
    return Math.max(0, activeIndex);
  };

  const mutationResult = (command: RuntimeCommand) => ({
    command,
    overrides: cloneOverrides(),
    checkpointHtml: serializeDocument(),
    slideCount: directDeckSlides().length,
    activeSlideIndex: currentSlideIndex(),
    selection: currentSelection
      ? selectionSnapshotFor(currentSelection, currentPath)
      : null,
  });

  const ackSuccess = (requestId: string, command: RuntimeCommand) => {
    const acknowledgement = {
      type: "hse:mutation-ack",
      requestId,
      status: "success",
      result: mutationResult(command),
    };
    mutationAcks.set(requestId, acknowledgement);
    send(acknowledgement);
  };

  const ackError = (requestId: string, error: unknown) => {
    const acknowledgement = {
      type: "hse:mutation-ack",
      requestId,
      status: "error",
      error: {
        code:
          error instanceof Error &&
          error.message === "편집 대상을 찾을 수 없습니다."
            ? "TARGET_NOT_FOUND"
            : "MUTATION_REJECTED",
        message:
          error instanceof Error
            ? error.message
            : "편집 요청을 처리할 수 없습니다.",
      },
    };
    mutationAcks.set(requestId, acknowledgement);
    send(acknowledgement);
  };

  const requireTarget = (targetId: unknown) => {
    if (typeof targetId !== "string" || !targetId) {
      throw new Error("편집 대상을 찾을 수 없습니다.");
    }
    const target = targetFor(targetId);
    if (!target) throw new Error("편집 대상을 찾을 수 없습니다.");
    return target;
  };

  const handleInitialMutation = (
    message: Record<string, unknown>,
  ): RuntimeCommand => {
    const id = String(message.commandId ?? "");
    const label = String(message.label ?? "");
    if (!id || !label) throw new Error("편집 command가 올바르지 않습니다.");

    switch (message.type) {
      case "hse:apply-patch": {
        const target = requireTarget(message.targetId);
        const applied = applyPatchRequest(target, message.patch);
        activateSlide(Math.max(0, slideIndexFor(target)), target);
        return {
          id,
          label,
          kind: "patch",
          targetId: applied.targetId,
          before: applied.before,
          after: applied.after,
        };
      }
      case "hse:duplicate-object": {
        const source = requireTarget(message.targetId);
        if (directDeckSlides().includes(source as HTMLElement)) {
          throw new Error("슬라이드 객체가 아닙니다.");
        }
        if (!source.parentElement) {
          throw new Error("요소가 문서에 연결되어 있지 않습니다.");
        }
        const result = duplicateObject(source);
        const copy = result.element!;
        const targetId = ensurePersistentId(copy);
        registerPersistentSubtree(copy);
        const overrideDelta = copyOverrideDelta(result.persistentIdMap);
        applyOverrideDelta(overrideDelta);
        activateSlide(Math.max(0, slideIndexFor(copy)), copy);
        return {
          id,
          label,
          kind: "duplicate-object",
          targetId,
          before: structuralState(
            result.before,
            Object.fromEntries(
              Object.keys(overrideDelta).map((copiedId) => [copiedId, null]),
            ),
          ),
          after: structuralState(result.after, overrideDelta),
        };
      }
      case "hse:delete-object": {
        const target = requireTarget(message.targetId);
        if (directDeckSlides().includes(target as HTMLElement)) {
          throw new Error("슬라이드 객체가 아닙니다.");
        }
        if (!target.parentElement) {
          throw new Error("요소가 문서에 연결되어 있지 않습니다.");
        }
        const targetSlideIndex = Math.max(0, slideIndexFor(target));
        const targetId = ensurePersistentId(target);
        persistentIds.set(targetId, target);
        const result = deleteObject(target);
        persistentIds.delete(targetId);
        activateSlide(targetSlideIndex, null);
        return {
          id,
          label,
          kind: "delete-object",
          targetId,
          before: result.before,
          after: result.after,
        };
      }
      case "hse:reorder-slide": {
        if (
          !Number.isInteger(message.fromIndex) ||
          !Number.isInteger(message.toIndex)
        ) {
          throw new Error("슬라이드 순서 범위를 벗어났습니다.");
        }
        const slide = slideAt(message.fromIndex as number);
        slideAt(message.toIndex as number);
        const targetId = ensurePersistentId(slide);
        persistentIds.set(targetId, slide);
        const result = reorderSlide(slide, message.toIndex as number);
        activateSlide(message.toIndex as number, null);
        return {
          id,
          label,
          kind: "reorder-slide",
          targetId,
          before: result.before,
          after: result.after,
        };
      }
      case "hse:duplicate-slide": {
        if (!Number.isInteger(message.slideIndex)) {
          throw new Error("슬라이드 순서 범위를 벗어났습니다.");
        }
        const source = slideAt(message.slideIndex as number);
        const result = duplicateSlide(source);
        const copy = result.element!;
        const targetId = ensurePersistentId(copy);
        registerPersistentSubtree(copy);
        const overrideDelta = copyOverrideDelta(result.persistentIdMap);
        applyOverrideDelta(overrideDelta);
        activateSlide(
          directDeckSlides().indexOf(copy),
          null,
        );
        return {
          id,
          label,
          kind: "duplicate-slide",
          targetId,
          before: structuralState(
            result.before,
            Object.fromEntries(
              Object.keys(overrideDelta).map((copiedId) => [copiedId, null]),
            ),
          ),
          after: structuralState(result.after, overrideDelta),
        };
      }
      case "hse:delete-slide": {
        if (!Number.isInteger(message.slideIndex)) {
          throw new Error("슬라이드 순서 범위를 벗어났습니다.");
        }
        const target = slideAt(message.slideIndex as number);
        if (directDeckSlides().length === 1) {
          throw new Error("마지막 슬라이드는 삭제할 수 없습니다.");
        }
        const deletedIndex = message.slideIndex as number;
        const targetId = ensurePersistentId(target);
        persistentIds.set(targetId, target);
        const result = deleteSlide(target);
        persistentIds.delete(targetId);
        activateSlide(deletedIndex, null);
        return {
          id,
          label,
          kind: "delete-slide",
          targetId,
          before: result.before,
          after: result.after,
        };
      }
      default:
        throw new Error("지원하지 않는 편집 요청입니다.");
    }
  };

  const isRuntimeCommand = (value: unknown): value is RuntimeCommand => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const command = value as Record<string, unknown>;
    return (
      typeof command.id === "string" &&
      typeof command.label === "string" &&
      typeof command.kind === "string" &&
      typeof command.targetId === "string" &&
      "before" in command &&
      "after" in command
    );
  };

  const handleHistoryMutation = (
    message: Record<string, unknown>,
  ): RuntimeCommand => {
    if (
      !isRuntimeCommand(message.command) ||
      (message.direction !== "before" && message.direction !== "after")
    ) {
      throw new Error("히스토리 command가 올바르지 않습니다.");
    }
    const command = message.command;
    const descriptor = command[message.direction];
    if (command.kind === "patch") {
      const target = requireTarget(command.targetId);
      applyPatchState(target, descriptor);
      activateSlide(Math.max(0, slideIndexFor(target)), target);
    } else {
      const activeBefore = currentSlideIndex();
      const structural =
        descriptor &&
        typeof descriptor === "object" &&
        "dom" in descriptor &&
        "overrideDelta" in descriptor
          ? (descriptor as RuntimeStructuralState)
          : null;
      const element = applyDomMutationRecord(
        command.targetId,
        structural
          ? structural.dom
          : (descriptor as {
              parentId: string;
              index: number;
              html: string;
            } | null),
      );
      if (structural) {
        applyOverrideDelta(structural.overrideDelta);
        if (element) registerPersistentSubtree(element);
        for (const [id, value] of Object.entries(
          structural.overrideDelta,
        )) {
          if (value === null) persistentIds.delete(id);
        }
      }
      if (element && !directDeckSlides().includes(element as HTMLElement)) {
        persistentIds.set(command.targetId, element);
        activateSlide(Math.max(0, slideIndexFor(element)), element);
      } else if (
        command.kind === "duplicate-slide" ||
        command.kind === "delete-slide" ||
        command.kind === "reorder-slide"
      ) {
        if (element) persistentIds.set(command.targetId, element);
        else persistentIds.delete(command.targetId);
        activateSlide(
          element ? Math.max(0, slideIndexFor(element)) : activeBefore,
          null,
        );
      } else {
        if (!element) persistentIds.delete(command.targetId);
        setCurrentSelection(null);
      }
    }
    return command;
  };

  const beginTextEdit = (element: Element) => {
    if (!(element instanceof HTMLElement) || kindFor(element) !== "text") {
      return;
    }
    editing = {
      element,
      originalHtml: element.innerHTML,
      originalText: element.textContent ?? "",
      targetId: idFor(element),
    };
    element.setAttribute("contenteditable", "true");
    element.focus();
  };

  const finishTextEdit = (commit: boolean) => {
    if (!editing) return;
    const { element, originalHtml, originalText, targetId } = editing;
    const after = element.textContent ?? "";
    element.innerHTML = originalHtml;
    element.removeAttribute("contenteditable");
    editing = null;
    sendSelectionFor(element);
    if (commit && after !== originalText) {
      send({
        type: "hse:inline-text-commit",
        targetId,
        before: originalText,
        after,
      });
    }
  };

  const beginEditForPath = (path: Element[]) => {
    currentPath = path;
    const textElement = nearestTextElement(path);
    if (textElement) {
      currentDepth = 0;
      sendSelectionFor(textElement, path);
      beginTextEdit(textElement);
      return;
    }
    currentDepth += 1;
    sendSelection(path);
    if (currentSelection && kindFor(currentSelection) === "text") {
      beginTextEdit(currentSelection);
    }
  };

  const selectSibling = (direction: 1 | -1) => {
    if (!currentSelection?.parentElement) return;
    const siblings = [...currentSelection.parentElement.children].filter(
      (element) => isEditableCandidate(element),
    );
    if (siblings.length < 2) return;
    const currentIndex = siblings.indexOf(currentSelection);
    const next =
      siblings[
        (currentIndex + direction + siblings.length) % siblings.length
      ];
    currentDepth = 0;
    sendSelectionFor(next);
  };

  function handleClick(event: MouseEvent) {
    if (editing) {
      stopDeckPropagation(event);
      return;
    }
    stopDeckInput(event);
    if (!initialize()) return;
    currentDepth = 0;
    currentPath = elementPath(event);
    sendSelection(currentPath);
  }

  function handleDoubleClick(event: MouseEvent) {
    if (editing) {
      stopDeckPropagation(event);
      return;
    }
    stopDeckInput(event);
    if (!initialize()) return;
    beginEditForPath(elementPath(event));
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (editing) {
      if (event.key === "Escape") {
        stopDeckInput(event);
        finishTextEdit(false);
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        stopDeckInput(event);
        finishTextEdit(true);
        return;
      }
      stopDeckPropagation(event);
      return;
    }

    if (event.key === "Enter" && currentSelection) {
      stopDeckInput(event);
      beginTextEdit(currentSelection);
      return;
    }
    if (event.key === "Escape") {
      stopDeckInput(event);
      currentDepth = Math.max(0, currentDepth - 1);
      sendSelection(currentPath);
      return;
    }
    if (event.key === "Tab") {
      stopDeckInput(event);
      selectSibling(event.shiftKey ? -1 : 1);
      return;
    }
    if (!navigationKeys.has(event.key)) return;

    stopDeckInput(event);
    send({
      type: "hse:editor-key",
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  function handleFocusOut(event: FocusEvent) {
    if (
      editing &&
      event.target instanceof Node &&
      editing.element.contains(event.target) &&
      (!(event.relatedTarget instanceof Node) ||
        !editing.element.contains(event.relatedTarget))
    ) {
      finishTextEdit(true);
    }
  }

  const runtimeErrorMessage = (value: unknown) => {
    if (value instanceof Error) return value.message;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { message?: unknown }).message === "string"
    ) {
      return (value as { message: string }).message;
    }
    if (typeof value === "string") return value;
    return "알 수 없는 런타임 오류";
  };

  const isSandboxRestriction = (value: unknown) =>
    typeof DOMException !== "undefined" &&
    value instanceof DOMException &&
    value.name === "SecurityError";

  function handleRuntimeError(event: ErrorEvent) {
    if (isSandboxRestriction(event.error)) return;
    send({
      type: "hse:error",
      kind: "error",
      message: event.message || runtimeErrorMessage(event.error),
      slideIndex:
        directDeckSlides().length > 0 ? currentSlideIndex() : null,
    });
  }

  function handleUnhandledRejection(event: PromiseRejectionEvent) {
    if (isSandboxRestriction(event.reason)) return;
    send({
      type: "hse:error",
      kind: "unhandledrejection",
      message: runtimeErrorMessage(event.reason),
      slideIndex:
        directDeckSlides().length > 0 ? currentSlideIndex() : null,
    });
  }

  function serializeDocument() {
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    if (editing) {
      const selector = editing.element.hasAttribute("data-hse-id")
        ? `[data-hse-id="${CSS.escape(editing.targetId)}"]`
        : `[data-hse-temp-id="${CSS.escape(editing.targetId)}"]`;
      const clonedEditing = root.querySelector<HTMLElement>(selector);
      if (clonedEditing) clonedEditing.innerHTML = editing.originalHtml;
    }
    cleanupEditorState(root, EDITOR_CLEANUP_MANIFEST);
    const doctype = document.doctype ? "<!DOCTYPE html>\n" : "";
    return `${doctype}${root.outerHTML}`;
  }

  function handleDomContentLoaded() {
    initialize();
  }

  function handleMessage(event: MessageEvent) {
    const message = event.data;
    if (
      event.source !== window.parent ||
      !message ||
      typeof message !== "object" ||
      message.token !== config.token
    ) {
      return;
    }

    if (
      message.type === "hse:select-depth" &&
      Number.isInteger(message.depth) &&
      message.depth >= 0
    ) {
      currentDepth = message.depth;
      sendSelection(currentPath);
      return;
    }

    if (
      message.type === "hse:select-slide" &&
      Number.isInteger(message.slideIndex) &&
      message.slideIndex >= 0
    ) {
      if (message.slideIndex >= directDeckSlides().length) {
        return;
      }
      activateSlide(message.slideIndex, null);
      return;
    }

    if (
      message.type === "hse:commit-inline-edit" &&
      typeof message.requestId === "string" &&
      message.requestId.length > 0
    ) {
      finishTextEdit(true);
      send({
        type: "hse:inline-text-flush",
        requestId: message.requestId,
      });
      return;
    }

    if (
      message.type === "hse:edit-at-point" &&
      Number.isFinite(message.x) &&
      Number.isFinite(message.y)
    ) {
      if (editing || !initialize()) return;
      const hit = document.elementFromPoint(message.x, message.y);
      const slide = deckSlideFor(hit);
      if (!hit || !slide || hit === slide) return;
      currentDepth = 0;
      beginEditForPath(pathFor(hit));
      return;
    }

    if (
      message.type === "hse:request-document" &&
      typeof message.requestId === "string" &&
      message.requestId.length > 0
    ) {
      send({
        type: "hse:document",
        requestId: message.requestId,
        html: serializeDocument(),
      });
      return;
    }

    if (
      typeof message.type === "string" &&
      [
        "hse:apply-patch",
        "hse:duplicate-object",
        "hse:delete-object",
        "hse:reorder-slide",
        "hse:duplicate-slide",
        "hse:delete-slide",
        "hse:apply-history",
      ].includes(message.type) &&
      typeof message.requestId === "string" &&
      message.requestId.length > 0
    ) {
      const cached = mutationAcks.get(message.requestId);
      if (cached) {
        send(cached);
        return;
      }
      try {
        const command =
          message.type === "hse:apply-history"
            ? handleHistoryMutation(message)
            : handleInitialMutation(message);
        ackSuccess(message.requestId, command);
      } catch (error) {
        ackError(message.requestId, error);
      }
      return;
    }

    if (message.type === "hse:reset") {
      stopBuildStepReveal();
      window.removeEventListener("click", handleClick, capture);
      window.removeEventListener("dblclick", handleDoubleClick, capture);
      window.removeEventListener("keydown", handleKeyDown, capture);
      window.removeEventListener("focusout", handleFocusOut, capture);
      window.removeEventListener("error", handleRuntimeError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      window.removeEventListener("message", handleMessage, false);
      document.removeEventListener(
        "DOMContentLoaded",
        handleDomContentLoaded,
        false,
      );
      finishTextEdit(false);
      document
        .querySelectorAll("script[data-hse-editor-bridge]")
        .forEach((element) => element.remove());
      document.querySelector("style#hse-live-overrides")?.remove();
      currentDepth = 0;
      currentPath = [];
      currentSelection = null;
      idSequence = 0;
      initialized = false;
      elementIds = new WeakMap<Element, string>();
      temporaryIds = new Map<string, Element>();
      persistentIds = new Map<string, Element>();
      overrides = {};
      mutationAcks.clear();
      document.querySelectorAll("[data-hse-temp-id]").forEach((element) => {
        element.removeAttribute("data-hse-temp-id");
      });
    }
  }

  window.addEventListener("click", handleClick, capture);
  window.addEventListener("dblclick", handleDoubleClick, capture);
  window.addEventListener("keydown", handleKeyDown, capture);
  window.addEventListener("focusout", handleFocusOut, capture);
  window.addEventListener("error", handleRuntimeError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  window.addEventListener("message", handleMessage, false);

  if (
    document.readyState === "loading" &&
    !document.querySelector("#stage")
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      handleDomContentLoaded,
      false,
    );
  } else {
    initialize();
  }
}
