import { useRef, useState, type ChangeEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { ElementPatch } from "./core/document/types";
import type { SerializableEditCommand } from "./core/history/commandHistory";
import { CanvasStage } from "./editor/components/CanvasStage";
import { CanvasViewport } from "./editor/components/CanvasViewport";
import { Inspector } from "./editor/components/Inspector";
import { RecoveryDialog } from "./editor/components/RecoveryDialog";
import { SlideRail } from "./editor/components/SlideRail";
import { StatusBar } from "./editor/components/StatusBar";
import { Toolbar } from "./editor/components/Toolbar";
import {
  useDeckSession,
  type DeckSessionController,
} from "./editor/hooks/useDeckSession";

const MIN_ZOOM = 25;
const MAX_ZOOM = 200;

export interface AppProps {
  sessionHook?: () => DeckSessionController;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "요청을 처리할 수 없습니다.";

const editedFileName = (fileName: string) => {
  const baseName = fileName.replace(/\.html?$/i, "") || "slides";
  return `${baseName}-edited.html`;
};

export default function App({ sessionHook = useDeckSession }: AppProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(100);
  const [actionError, setActionError] = useState<string | null>(null);
  const {
    state,
    history,
    recovery,
    recoveryError,
    recoveryBusy,
    frameRef,
    openFile,
    handleFrameMessage,
    sendCommand,
    undo,
    redo,
    selectSlide,
    exportDeck,
    restoreRecovery,
    discardRecovery,
    markRecoveryExported,
  } = sessionHook();
  const session = state.session;
  const mutationsEnabled =
    state.status === "ready" && session?.previewUrl !== null;

  const dispatchCommand = (command: SerializableEditCommand) => {
    void sendCommand(command).catch(() => {});
  };

  const commandId = (kind: string) => `${kind}-${crypto.randomUUID()}`;

  const patchSelection = (patch: ElementPatch) => {
    const selection = state.selection;
    if (!selection || Object.keys(patch).length === 0) return;
    const before: ElementPatch = {};
    if (patch.translateX !== undefined) {
      before.translateX = selection.transform?.translateX ?? 0;
      patch = {
        ...patch,
        translateX:
          before.translateX + patch.translateX - selection.bounds.x,
      };
    }
    if (patch.translateY !== undefined) {
      before.translateY = selection.transform?.translateY ?? 0;
      patch = {
        ...patch,
        translateY:
          before.translateY + patch.translateY - selection.bounds.y,
      };
    }
    if (patch.width !== undefined) before.width = selection.bounds.width;
    if (patch.height !== undefined) {
      before.height =
        selection.kind === "text" ? "auto" : selection.bounds.height;
    }
    if (patch.text !== undefined) before.text = selection.text ?? "";
    if (patch.fontSize !== undefined) {
      before.fontSize = selection.styles?.fontSize ?? "";
    }
    if (patch.color !== undefined) {
      before.color = selection.styles?.color ?? "";
    }
    if (patch.fontWeight !== undefined) {
      before.fontWeight = selection.styles?.fontWeight ?? "";
    }
    if (patch.textAlign !== undefined) {
      before.textAlign = selection.styles?.textAlign ?? "left";
    }
    dispatchCommand({
      id: commandId("patch"),
      label: "Edit object",
      kind: "patch",
      targetId: selection.targetId,
      before,
      after: patch,
    });
  };

  const duplicateSelection = () => {
    if (!state.selection) return;
    dispatchCommand({
      id: commandId("duplicate-object"),
      label: "Duplicate object",
      kind: "duplicate-object",
      targetId: state.selection.targetId,
      before: null,
      after: null,
    });
  };

  const deleteSelection = () => {
    if (!state.selection) return;
    dispatchCommand({
      id: commandId("delete-object"),
      label: "Delete object",
      kind: "delete-object",
      targetId: state.selection.targetId,
      before: null,
      after: null,
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";
    if (selectedFile) {
      setActionError(null);
      void openFile(selectedFile);
    }
  };

  const downloadExport = async () => {
    setActionError(null);
    try {
      const prepared = await exportDeck();
      const blobUrl = URL.createObjectURL(
        new Blob([prepared.html], { type: "text/html" }),
      );
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = editedFileName(prepared.fileName);
      anchor.hidden = true;
      document.body.append(anchor);
      try {
        anchor.click();
        await markRecoveryExported();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(blobUrl);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  return (
    <>
    <main
      className="editor-app editor-app--powerpoint"
      inert={recovery ? true : undefined}
      aria-hidden={recovery ? "true" : undefined}
    >
      <Toolbar
        state={state}
        history={history}
        zoom={zoom}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        actions={{
          requestOpen: () => fileInputRef.current?.click(),
          undo,
          redo,
          exportDeck: downloadExport,
          duplicateSelection,
          deleteSelection,
          zoomIn: () =>
            setZoom((value) => Math.min(MAX_ZOOM, value + 10)),
          zoomOut: () =>
            setZoom((value) => Math.max(MIN_ZOOM, value - 10)),
        }}
      />
      <input
        ref={fileInputRef}
        aria-label="HTML 파일 선택"
        type="file"
        accept=".html,.htm,text/html"
        hidden
        onChange={handleFileChange}
      />
      <SlideRail
        slideCount={session?.slideCount ?? 0}
        activeSlide={session?.activeSlide ?? 1}
        previewUrl={session?.previewUrl ?? null}
        mutationsEnabled={mutationsEnabled}
        selectionEnabled={mutationsEnabled}
        onSelect={selectSlide}
        onReorder={(fromIndex, toIndex) =>
          dispatchCommand({
            id: commandId("reorder-slide"),
            label: "Reorder slide",
            kind: "reorder-slide",
            targetId: `slide-${fromIndex}`,
            before: { index: fromIndex },
            after: { index: toIndex },
          })
        }
        onDuplicate={(index) =>
          dispatchCommand({
            id: commandId("duplicate-slide"),
            label: "Duplicate slide",
            kind: "duplicate-slide",
            targetId: `slide-${index - 1}`,
            before: { slideIndex: index - 1 },
            after: null,
          })
        }
        onDelete={(index) =>
          dispatchCommand({
            id: commandId("delete-slide"),
            label: "Delete slide",
            kind: "delete-slide",
            targetId: `slide-${index - 1}`,
            before: null,
            after: { slideIndex: index - 1 },
          })
        }
      />
      <section aria-label="슬라이드 캔버스" className="canvas-shell">
        {state.selection?.path.length ? (
          <nav
            aria-label="선택 경로"
            className="selection-breadcrumb"
          >
            <ol>
              {state.selection.path.map((segment, index) => (
                <li
                  key={`${segment}-${index}`}
                  aria-current={
                    index === state.selection!.path.length - 1
                      ? "page"
                      : undefined
                  }
                >
                  {segment}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        {session ? (
          <CanvasViewport zoom={zoom} stageSize={session.stageSize}>
            <CanvasStage
              frameRef={frameRef}
              srcDoc={session.srcDoc}
              recoverySrcDoc={session.recoverySrcDoc}
              token={session.token}
              stageSize={session.stageSize}
              selection={state.selection}
              onMessage={handleFrameMessage}
              onCommit={({ targetId, before, patch }) =>
                dispatchCommand({
                  id: commandId("transform"),
                  label: "Transform object",
                  kind: "patch",
                  targetId,
                  before,
                  after: patch,
                })
              }
            />
          </CanvasViewport>
        ) : (
          <div className="canvas-empty">
            <ShieldAlert aria-hidden="true" size={20} />
            <p role="note">
              신뢰하는 로컬 HTML 파일만 여세요. 파일의 JavaScript가
              실행됩니다.
            </p>
          </div>
        )}
      </section>
      <Inspector
        selection={state.selection}
        disabled={!mutationsEnabled}
        onPatch={patchSelection}
        onDuplicate={duplicateSelection}
        onDelete={deleteSelection}
      />
      <StatusBar
        status={state.status}
        error={actionError ?? recoveryError ?? state.error}
        fileName={session?.fileName ?? null}
        activeSlide={session?.activeSlide ?? 1}
        slideCount={session?.slideCount ?? 0}
        zoom={zoom}
        dirty={session?.dirty ?? false}
      />
    </main>
    {recovery ? (
      <RecoveryDialog
        recovery={recovery}
        currentFingerprint={session?.fingerprint ?? null}
        busy={recoveryBusy}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
      />
    ) : null}
    </>
  );
}
