import {
  validateExport,
  type HtmlIdCounts,
} from "./exportDocument";

export type ExportValidationResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "INVALID_HTML"
        | "SLIDE_COUNT"
        | "EDITOR_ARTIFACT"
        | "RUNTIME_TIMEOUT"
        | "RUNTIME_ERROR"
        | "NAVIGATION";
      message: string;
    };

export interface RuntimeValidationOptions {
  timeoutMs?: number;
  validationToken?: string;
}

const DEFAULT_RUNTIME_TIMEOUT_MS = 5_000;
const MAX_NESTED_SRCDOC_DEPTH = 8;
const MAX_NESTED_SRCDOC_CHARACTERS = 1_000_000;

const directEditorArtifact = (root: ParentNode): string | null => {
  if (root.querySelector("[data-hse-editor-bridge]")) {
    return "편집기 브리지 마커가 남아 있습니다.";
  }
  if (root.querySelector("[data-hse-editor-artifact]")) {
    return "편집기 artifact가 남아 있습니다.";
  }
  if (root.querySelector("#hse-live-overrides")) {
    return "실시간 override 스타일이 남아 있습니다.";
  }
  if (root.querySelector("[data-hse-temp-id]")) {
    return "임시 편집기 ID가 남아 있습니다.";
  }
  if (root.querySelector("[contenteditable]")) {
    return "contenteditable 상태가 남아 있습니다.";
  }
  const hasSelectionState = [...root.querySelectorAll("*")].some(
    (element) =>
      [...element.attributes].some(
        (attribute) =>
          attribute.name === "data-hse-selected" ||
          attribute.name.startsWith("data-hse-selection"),
      ),
  );
  if (hasSelectionState) return "선택 상태가 남아 있습니다.";
  if (
    root.querySelector(
      ".slide.active,.slide.entered,[data-step].revealed",
    )
  ) {
    return "런타임 클래스가 남아 있습니다.";
  }
  return null;
};

const nestedEditorArtifact = (
  root: ParentNode,
  srcdocDepth = 0,
  budget = { remainingSrcdocCharacters: MAX_NESTED_SRCDOC_CHARACTERS },
): string | null => {
  const direct = directEditorArtifact(root);
  if (direct) return direct;

  for (const template of root.querySelectorAll("template")) {
    const nested = nestedEditorArtifact(
      template.content,
      srcdocDepth,
      budget,
    );
    if (nested) return nested;
  }

  for (const iframe of root.querySelectorAll("iframe[srcdoc]")) {
    const srcdoc = iframe.getAttribute("srcdoc");
    if (srcdoc === null) continue;
    if (
      srcdocDepth >= MAX_NESTED_SRCDOC_DEPTH ||
      srcdoc.length > budget.remainingSrcdocCharacters
    ) {
      return "중첩된 iframe srcdoc을 검증할 수 없습니다.";
    }

    budget.remainingSrcdocCharacters -= srcdoc.length;
    const document = new DOMParser().parseFromString(srcdoc, "text/html");
    const nested = nestedEditorArtifact(
      document,
      srcdocDepth + 1,
      budget,
    );
    if (nested) return nested;
  }
  return null;
};

export function validateExportStructure(
  html: string,
  expectedSlideCount: number,
  baselineIdCounts: HtmlIdCounts = {},
): ExportValidationResult {
  if (!/^\s*<!doctype\s+html(?:\s[^>]*)?>/i.test(html)) {
    return {
      ok: false,
      code: "INVALID_HTML",
      message: "내보내기 HTML에 doctype이 없습니다.",
    };
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  const stage = document.querySelector("#stage");
  if (!stage) {
    return {
      ok: false,
      code: "INVALID_HTML",
      message: "내보내기 HTML에 #stage 요소가 없습니다.",
    };
  }

  const slideCount = stage.querySelectorAll(":scope > .slide").length;
  if (slideCount !== expectedSlideCount) {
    return {
      ok: false,
      code: "SLIDE_COUNT",
      message: `슬라이드 수가 일치하지 않습니다. 예상 ${expectedSlideCount}개, 실제 ${slideCount}개입니다.`,
    };
  }

  const nestedArtifact = nestedEditorArtifact(document);
  if (nestedArtifact) {
    return {
      ok: false,
      code: "EDITOR_ARTIFACT",
      message: nestedArtifact,
    };
  }

  const artifactValidation = validateExport(html, baselineIdCounts);
  if (!artifactValidation.ok) {
    return {
      ok: false,
      code: "EDITOR_ARTIFACT",
      message: artifactValidation.errors.join("\n"),
    };
  }

  return { ok: true };
}

export async function validateExportInFrame(
  html: string,
  options: RuntimeValidationOptions = {},
): Promise<ExportValidationResult> {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const slides = parsedDocument.querySelectorAll("#stage > .slide");
  const expectedTotal = slides.length;
  const maximumNextActions =
    (slides[0]?.querySelectorAll("[data-step]").length ?? 0) + 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const validationToken =
    options.validationToken ??
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `validation-${Date.now()}-${Math.random()}`);
  const observer = parsedDocument.createElement("script");
  observer.textContent = `(() => {
    const validationToken = ${JSON.stringify(validationToken)};
    const messageFor = (value) => {
      if (value && typeof value.message === "string") return value.message;
      if (typeof value === "string") return value;
      return "Unknown runtime error";
    };
    addEventListener("error", (event) => {
      parent.postMessage({
        type: "hse:export-runtime-error",
        validationToken,
        kind: "error",
        message: event.message || messageFor(event.error),
      }, "*");
    });
    addEventListener("unhandledrejection", (event) => {
      event.preventDefault();
      const message = messageFor(event.reason);
      if (message === "Transition was skipped") return;
      parent.postMessage({
        type: "hse:export-runtime-error",
        validationToken,
        kind: "unhandledrejection",
        message,
      }, "*");
    });
  })();`;
  parsedDocument.head.prepend(observer);
  const instrumentedHtml = `<!DOCTYPE html>\n${parsedDocument.documentElement.outerHTML}`;
  let activeToken: string | null = validationToken;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  let successTimer: ReturnType<typeof setTimeout> | undefined;
  let phase: "initial" | "next" = "initial";
  let nextActions = 0;

  const blobUrl = URL.createObjectURL(
    new Blob([instrumentedHtml], { type: "text/html" }),
  );
  const iframe = document.createElement("iframe");
  iframe.title = "내보내기 검증";
  iframe.tabIndex = -1;
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-scripts");
  Object.assign(iframe.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });

  let settle!: (result: ExportValidationResult) => void;
  const resultPromise = new Promise<ExportValidationResult>((resolve) => {
    settle = resolve;
  });
  const finish = (result: ExportValidationResult) => {
    if (activeToken !== validationToken) return;
    activeToken = null;
    settle(result);
  };
  const navigationFailure = (message: string) =>
    finish({ ok: false, code: "NAVIGATION", message });
  const scheduleSuccess = () => {
    if (successTimer !== undefined) return;
    successTimer = setTimeout(() => {
      successTimer = undefined;
      finish({ ok: true });
    }, 0);
  };
  const sendNext = () => {
    if (
      activeToken !== validationToken ||
      phase !== "next" ||
      nextActions >= maximumNextActions
    ) {
      return;
    }
    try {
      iframe.contentWindow?.postMessage(
        { type: "slidecast-nav", action: "next" },
        "*",
      );
      nextActions += 1;
      navigationTimer = setTimeout(sendNext, 0);
    } catch {
      navigationFailure("슬라이드 다음 이동 요청을 보낼 수 없습니다.");
    }
  };

  const handleMessage = (event: MessageEvent) => {
    const frameWindow = iframe.contentWindow;
    if (
      activeToken !== validationToken ||
      !frameWindow ||
      event.source !== frameWindow
    ) {
      return;
    }

    const data = event.data as {
      type?: unknown;
      validationToken?: unknown;
      kind?: unknown;
      message?: unknown;
      cur?: unknown;
      total?: unknown;
    } | null;
    if (
      data?.type === "hse:export-runtime-error" &&
      data.validationToken === validationToken
    ) {
      finish({
        ok: false,
        code: "RUNTIME_ERROR",
        message: `내보내기 런타임 오류: ${
          typeof data.message === "string"
            ? data.message
            : "알 수 없는 오류"
        }`,
      });
      return;
    }
    if (!data || data.type !== "slidecast-state") return;
    if (
      !Number.isInteger(data.cur) ||
      !Number.isInteger(data.total)
    ) {
      navigationFailure("슬라이드 런타임 상태를 확인할 수 없습니다.");
      return;
    }

    if (phase === "initial") {
      if (data.cur !== 1 || data.total !== expectedTotal) {
        navigationFailure(
          "슬라이드 런타임의 초기 상태가 올바르지 않습니다.",
        );
        return;
      }
      if (expectedTotal === 1) {
        scheduleSuccess();
        return;
      }

      phase = "next";
      sendNext();
      return;
    }

    if (data.cur === 1 && data.total === expectedTotal) {
      return;
    }
    if (data.cur !== 2 || data.total !== expectedTotal) {
      navigationFailure("슬라이드 다음 이동을 확인할 수 없습니다.");
      return;
    }
    scheduleSuccess();
  };

  try {
    document.body.append(iframe);
    window.addEventListener("message", handleMessage);
    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        code: "RUNTIME_TIMEOUT",
        message: "슬라이드 런타임 검증 시간이 초과되었습니다.",
      });
    }, timeoutMs);
    iframe.src = blobUrl;
    return await resultPromise;
  } finally {
    activeToken = null;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (navigationTimer !== undefined) clearTimeout(navigationTimer);
    if (successTimer !== undefined) clearTimeout(successTimer);
    window.removeEventListener("message", handleMessage);
    iframe.remove();
    URL.revokeObjectURL(blobUrl);
  }
}
