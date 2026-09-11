import {
  Copy,
  Download,
  FolderOpen,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ReactNode } from "react";
import type { HistorySnapshot } from "../../core/history/commandHistory";
import type { EditorState } from "../state/editorReducer";

export interface ToolbarActions {
  requestOpen(): void;
  undo(): void | Promise<unknown>;
  redo(): void | Promise<unknown>;
  exportDeck(): void | Promise<unknown>;
  duplicateSelection?(): void | Promise<unknown>;
  deleteSelection?(): void | Promise<unknown>;
  zoomIn(): void;
  zoomOut(): void;
}

export interface ToolbarProps {
  state: EditorState;
  history: HistorySnapshot;
  actions: ToolbarActions;
  zoom: number;
  minZoom: number;
  maxZoom: number;
}

interface IconButtonProps {
  label: string;
  disabled?: boolean;
  onClick(): void | Promise<unknown>;
  children: ReactNode;
}

function IconButton({
  label,
  disabled = false,
  onClick,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="toolbar__icon-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {children}
    </button>
  );
}

export function Toolbar({
  state,
  history,
  actions,
  zoom,
  minZoom,
  maxZoom,
}: ToolbarProps) {
  const hasDeck = state.session !== null;
  const deckReady = state.session?.previewUrl !== null;
  const busy =
    state.status === "loading" || state.status === "exporting";
  const hasSelection = state.selection !== null;

  return (
    <header className="toolbar" aria-label="편집 도구">
      <div className="toolbar__group">
        <IconButton label="HTML 열기" onClick={actions.requestOpen}>
          <FolderOpen aria-hidden="true" size={18} />
        </IconButton>
      </div>
      <div className="toolbar__divider" aria-hidden="true" />
      <div className="toolbar__group">
        <IconButton
          label="실행 취소"
          disabled={!hasDeck || busy || !history.canUndo}
          onClick={actions.undo}
        >
          <Undo2 aria-hidden="true" size={18} />
        </IconButton>
        <IconButton
          label="다시 실행"
          disabled={!hasDeck || busy || !history.canRedo}
          onClick={actions.redo}
        >
          <Redo2 aria-hidden="true" size={18} />
        </IconButton>
      </div>
      <div className="toolbar__divider" aria-hidden="true" />
      <div className="toolbar__group">
        <IconButton
          label="선택 항목 복제"
          disabled={
            !hasDeck ||
            busy ||
            !hasSelection ||
            !actions.duplicateSelection
          }
          onClick={() => actions.duplicateSelection?.()}
        >
          <Copy aria-hidden="true" size={18} />
        </IconButton>
        <IconButton
          label="선택 항목 삭제"
          disabled={
            !hasDeck ||
            busy ||
            !hasSelection ||
            !actions.deleteSelection
          }
          onClick={() => actions.deleteSelection?.()}
        >
          <Trash2 aria-hidden="true" size={18} />
        </IconButton>
      </div>
      <div className="toolbar__spacer" />
      <div className="toolbar__group">
        <IconButton
          label="축소"
          disabled={!hasDeck || busy || zoom <= minZoom}
          onClick={actions.zoomOut}
        >
          <ZoomOut aria-hidden="true" size={18} />
        </IconButton>
        <IconButton
          label="확대"
          disabled={!hasDeck || busy || zoom >= maxZoom}
          onClick={actions.zoomIn}
        >
          <ZoomIn aria-hidden="true" size={18} />
        </IconButton>
      </div>
      <button
        type="button"
        className="toolbar__export-button"
        aria-label="HTML 내보내기"
        disabled={!hasDeck || !deckReady || busy}
        onClick={() => void actions.exportDeck()}
      >
        <Download aria-hidden="true" size={17} />
        <span>
          {state.status === "exporting" ? "검증 중" : "HTML 내보내기"}
        </span>
      </button>
    </header>
  );
}
