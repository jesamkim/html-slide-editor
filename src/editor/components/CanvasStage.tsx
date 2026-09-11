import {
  useCallback,
  useEffect,
  useState,
  type MutableRefObject,
} from "react";
import {
  DeckFrame,
  type DeckFrameHandle,
} from "../../bridge/DeckFrame";
import type { FrameToParentMessage } from "../../bridge/protocol";
import type {
  ElementPatch,
  SelectionSnapshot,
  StageSize,
} from "../../core/document/types";
import { SelectionOverlay } from "./SelectionOverlay";

export interface CanvasStageProps {
  frameRef: MutableRefObject<DeckFrameHandle | null>;
  srcDoc: string;
  recoverySrcDoc: string;
  token: string;
  stageSize: StageSize;
  selection: SelectionSnapshot | null;
  onMessage(message: FrameToParentMessage): void;
  onCommit(command: {
    targetId: string;
    before: ElementPatch;
    patch: ElementPatch;
  }): void;
}

export function CanvasStage({
  frameRef,
  srcDoc,
  recoverySrcDoc,
  token,
  stageSize,
  selection,
  onMessage,
  onCommit,
}: CanvasStageProps) {
  const [frameElement, setFrameElement] =
    useState<HTMLIFrameElement | null>(null);
  const [frameRect, setFrameRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    setFrameRect(frameElement?.getBoundingClientRect() ?? null);
  }, [frameElement]);

  const requestEditAtPoint = useCallback(
    (viewportPoint: { x: number; y: number }) => {
      if (!frameElement) return;
      // getBoundingClientRect is post-transform and the zoom wrapper scales an
      // ancestor, while elementFromPoint inside the frame reads untransformed
      // viewport coordinates. clientWidth is the layout size, so their ratio
      // undoes the zoom whatever it happens to be.
      const rect = frameElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      frameRef.current?.send({
        type: "hse:edit-at-point",
        x: ((viewportPoint.x - rect.left) * frameElement.clientWidth) /
          rect.width,
        y: ((viewportPoint.y - rect.top) * frameElement.clientHeight) /
          rect.height,
      });
    },
    [frameElement, frameRef],
  );

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer =
      frameElement && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (frameElement) observer?.observe(frameElement);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [frameElement, measure]);

  return (
    <>
      <DeckFrame
        ref={(handle) => {
          frameRef.current = handle;
        }}
        onFrameElement={setFrameElement}
        className="canvas-shell__frame"
        srcDoc={srcDoc}
        recoverySrcDoc={recoverySrcDoc}
        token={token}
        onMessage={onMessage}
      />
      {selection && frameRect ? (
        <SelectionOverlay
          canvasRect={frameRect}
          stageSize={stageSize}
          selection={selection}
          snapTargets={selection.snapTargets}
          onCommit={onCommit}
          onEditAtPoint={requestEditAtPoint}
        />
      ) : null}
    </>
  );
}
