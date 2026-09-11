import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Copy,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ElementPatch,
  SelectionSnapshot,
} from "../../core/document/types";

export interface InspectorProps {
  selection: SelectionSnapshot | null;
  disabled?: boolean;
  onPatch?(patch: ElementPatch): void;
  onDuplicate?(): void;
  onDelete?(): void;
}

type InspectorTab = "text" | "arrange";

interface TextDraft {
  text: string;
  fontSize: string;
  color: string;
  fontWeight: string;
  textAlign: "left" | "center" | "right";
}

interface ArrangeDraft {
  x: string;
  y: string;
  width: string;
  height: string;
}

const numericText = (value: number) =>
  Number.isFinite(value) ? String(value) : "";
const fontSizeText = (value: string | undefined) =>
  value?.match(/^-?\d+(?:\.\d+)?/)?.[0] ?? "";
const colorValue = (value: string | undefined) =>
  /^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : "#1f2933";

const textDraftFor = (
  selection: SelectionSnapshot | null,
): TextDraft => ({
  text: selection?.text ?? "",
  fontSize: fontSizeText(selection?.styles?.fontSize),
  color: colorValue(selection?.styles?.color),
  fontWeight: selection?.styles?.fontWeight ?? "400",
  textAlign: selection?.styles?.textAlign ?? "left",
});

const arrangeDraftFor = (
  selection: SelectionSnapshot | null,
): ArrangeDraft => ({
  x: selection ? numericText(selection.bounds.x) : "",
  y: selection ? numericText(selection.bounds.y) : "",
  width: selection ? numericText(selection.bounds.width) : "",
  height: selection ? numericText(selection.bounds.height) : "",
});

const changedNumber = (
  draft: string,
  original: number | undefined,
): number | undefined => {
  const value = Number(draft);
  if (value === original) return undefined;
  return value;
};

const isFiniteDraft = (value: string) =>
  value.trim() !== "" && Number.isFinite(Number(value));
const isPositiveDraft = (value: string) =>
  isFiniteDraft(value) && Number(value) > 0;
const isNonnegativeDraft = (value: string) =>
  isFiniteDraft(value) && Number(value) >= 0;

const alignmentOptions: Array<{
  value: TextDraft["textAlign"];
  label: string;
  Icon: LucideIcon;
}> = [
  { value: "left", label: "왼쪽 정렬", Icon: AlignLeft },
  { value: "center", label: "가운데 정렬", Icon: AlignCenter },
  { value: "right", label: "오른쪽 정렬", Icon: AlignRight },
];

export function Inspector({
  selection,
  disabled = false,
  onPatch,
  onDuplicate,
  onDelete,
}: InspectorProps) {
  const idPrefix = useId();
  const textTabRef = useRef<HTMLButtonElement>(null);
  const arrangeTabRef = useRef<HTMLButtonElement>(null);
  const textSupported = selection?.kind === "text";
  const [tab, setTab] = useState<InspectorTab>(
    textSupported ? "text" : "arrange",
  );
  const [textDraft, setTextDraft] = useState(() =>
    textDraftFor(selection),
  );
  const [arrangeDraft, setArrangeDraft] = useState(() =>
    arrangeDraftFor(selection),
  );

  useEffect(() => {
    setTextDraft(textDraftFor(selection));
    setArrangeDraft(arrangeDraftFor(selection));
    setTab(selection?.kind === "text" ? "text" : "arrange");
  }, [selection]);

  const controlsDisabled = disabled || !selection || !onPatch;
  const textTabId = `${idPrefix}-text-tab`;
  const arrangeTabId = `${idPrefix}-arrange-tab`;
  const textPanelId = `${idPrefix}-text-panel`;
  const arrangePanelId = `${idPrefix}-arrange-panel`;
  const fontSizeValid = isPositiveDraft(textDraft.fontSize);
  const arrangeValidity = {
    x: isFiniteDraft(arrangeDraft.x),
    y: isFiniteDraft(arrangeDraft.y),
    width: isNonnegativeDraft(arrangeDraft.width),
    height: isNonnegativeDraft(arrangeDraft.height),
  };
  const arrangeValid = Object.values(arrangeValidity).every(Boolean);
  const textApplyDisabled = controlsDisabled || !fontSizeValid;
  const arrangeApplyDisabled = controlsDisabled || !arrangeValid;

  const activateTab = (nextTab: InspectorTab) => {
    setTab(nextTab);
    (nextTab === "text" ? textTabRef : arrangeTabRef).current?.focus();
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const enabledTabs: InspectorTab[] = textSupported
      ? ["text", "arrange"]
      : ["arrange"];
    const currentIndex = enabledTabs.indexOf(tab);
    let nextTab: InspectorTab | null = null;

    switch (event.key) {
      case "ArrowRight":
        nextTab = enabledTabs[(currentIndex + 1) % enabledTabs.length];
        break;
      case "ArrowLeft":
        nextTab =
          enabledTabs[
            (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
          ];
        break;
      case "Home":
        nextTab = enabledTabs[0];
        break;
      case "End":
        nextTab = enabledTabs[enabledTabs.length - 1];
        break;
    }

    if (nextTab) {
      event.preventDefault();
      activateTab(nextTab);
    }
  };

  const applyText = () => {
    if (!selection || !onPatch || textApplyDisabled) return;
    const patch: ElementPatch = {};
    const original = textDraftFor(selection);

    if (textDraft.text !== original.text) patch.text = textDraft.text;
    if (textDraft.fontSize !== original.fontSize) {
      patch.fontSize = `${textDraft.fontSize}px`;
    }
    if (textDraft.color !== original.color) {
      patch.color = textDraft.color;
    }
    if (textDraft.fontWeight !== original.fontWeight) {
      patch.fontWeight = textDraft.fontWeight;
    }
    if (textDraft.textAlign !== original.textAlign) {
      patch.textAlign = textDraft.textAlign;
    }
    if (Object.keys(patch).length > 0) onPatch(patch);
  };

  const applyArrange = () => {
    if (!selection || !onPatch || arrangeApplyDisabled) return;
    const patch: ElementPatch = {};
    const translateX = changedNumber(arrangeDraft.x, selection.bounds.x);
    const translateY = changedNumber(arrangeDraft.y, selection.bounds.y);
    const width = changedNumber(
      arrangeDraft.width,
      selection.bounds.width,
    );
    const height = changedNumber(
      arrangeDraft.height,
      selection.bounds.height,
    );

    if (translateX !== undefined) patch.translateX = translateX;
    if (translateY !== undefined) patch.translateY = translateY;
    if (width !== undefined) patch.width = width;
    if (height !== undefined) patch.height = height;
    if (Object.keys(patch).length > 0) onPatch(patch);
  };

  return (
    <aside aria-label="속성 패널" className="inspector">
      <div className="inspector__tabs" role="tablist" aria-label="속성">
        <button
          ref={textTabRef}
          id={textTabId}
          type="button"
          role="tab"
          aria-selected={tab === "text"}
          aria-controls={textPanelId}
          tabIndex={tab === "text" ? 0 : -1}
          disabled={!textSupported}
          onClick={() => setTab("text")}
          onKeyDown={handleTabKeyDown}
        >
          텍스트
        </button>
        <button
          ref={arrangeTabRef}
          id={arrangeTabId}
          type="button"
          role="tab"
          aria-selected={tab === "arrange"}
          aria-controls={arrangePanelId}
          tabIndex={tab === "arrange" ? 0 : -1}
          disabled={!selection}
          onClick={() => setTab("arrange")}
          onKeyDown={handleTabKeyDown}
        >
          배치
        </button>
      </div>

      <div className="inspector__body">
        {tab === "text" ? (
          <div
            id={textPanelId}
            className="inspector__panel"
            role="tabpanel"
            aria-labelledby={textTabId}
          >
            <label className="inspector__field inspector__field--stacked">
              <span>텍스트 내용</span>
              <textarea
                aria-label="텍스트 내용"
                value={textDraft.text}
                disabled={controlsDisabled}
                rows={4}
                onChange={(event) =>
                  setTextDraft((current) => ({
                    ...current,
                    text: event.target.value,
                  }))
                }
              />
            </label>
            <div className="inspector__row">
              <label className="inspector__field">
                <span>글자 크기</span>
                <input
                  aria-label="글자 크기"
                  type="number"
                  min="1"
                  step="any"
                  value={textDraft.fontSize}
                  aria-invalid={
                    selection && !fontSizeValid ? "true" : undefined
                  }
                  disabled={controlsDisabled}
                  onChange={(event) =>
                    setTextDraft((current) => ({
                      ...current,
                      fontSize: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="inspector__field inspector__color-field">
                <span>색상</span>
                <input
                  aria-label="글자 색상"
                  type="color"
                  value={textDraft.color}
                  disabled={controlsDisabled}
                  onChange={(event) =>
                    setTextDraft((current) => ({
                      ...current,
                      color: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <div className="inspector__row inspector__row--controls">
              <button
                type="button"
                className="inspector__toggle"
                aria-label="굵게"
                aria-pressed={textDraft.fontWeight === "700"}
                title="굵게"
                disabled={controlsDisabled}
                onClick={() =>
                  setTextDraft((current) => ({
                    ...current,
                    fontWeight:
                      current.fontWeight === "700" ? "400" : "700",
                  }))
                }
              >
                <Bold aria-hidden="true" size={17} />
              </button>
              <div
                className="inspector__segmented"
                role="group"
                aria-label="텍스트 정렬"
              >
                {alignmentOptions.map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={label}
                    aria-pressed={textDraft.textAlign === value}
                    title={label}
                    disabled={controlsDisabled}
                    onClick={() =>
                      setTextDraft((current) => ({
                        ...current,
                        textAlign: value,
                      }))
                    }
                  >
                    <Icon aria-hidden="true" size={17} />
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="inspector__apply"
              disabled={textApplyDisabled}
              onClick={applyText}
            >
              적용
            </button>
          </div>
        ) : (
          <div
            id={arrangePanelId}
            className="inspector__panel"
            role="tabpanel"
            aria-labelledby={arrangeTabId}
          >
            <div className="inspector__numeric-grid">
              {[
                ["x", "X 위치"],
                ["y", "Y 위치"],
                ["width", "너비"],
                ["height", "높이"],
              ].map(([key, label]) => (
                <label key={key} className="inspector__field">
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    type="number"
                    step="any"
                    value={arrangeDraft[key as keyof ArrangeDraft]}
                    aria-invalid={
                      selection &&
                      !arrangeValidity[key as keyof ArrangeDraft]
                        ? "true"
                        : undefined
                    }
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setArrangeDraft((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="inspector__apply"
              disabled={arrangeApplyDisabled}
              onClick={applyArrange}
            >
              적용
            </button>
          </div>
        )}
        {tab !== "text" ? (
          <div
            id={textPanelId}
            role="tabpanel"
            aria-labelledby={textTabId}
            hidden
          />
        ) : null}
        {tab !== "arrange" ? (
          <div
            id={arrangePanelId}
            role="tabpanel"
            aria-labelledby={arrangeTabId}
            hidden
          />
        ) : null}
      </div>

      <div className="inspector__object-actions">
        <button
          type="button"
          disabled={disabled || !selection || !onDuplicate}
          onClick={onDuplicate}
        >
          <Copy aria-hidden="true" size={16} />
          <span>선택 항목 복제</span>
        </button>
        <button
          type="button"
          disabled={disabled || !selection || !onDelete}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" size={16} />
          <span>선택 항목 삭제</span>
        </button>
      </div>
    </aside>
  );
}
