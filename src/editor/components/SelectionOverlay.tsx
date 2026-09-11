import Moveable from "react-moveable";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  Bounds,
  ElementPatch,
  SelectionKind,
  StageSize,
} from "../../core/document/types";
import {
  findResizeSnap,
  findSnap,
  moveBounds,
  resizeBounds,
  type ResizeHandle,
  type SnapGuide,
  type SnapTarget,
} from "../../core/interaction/geometry";

export interface SelectionOverlayProps {
  canvasRect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
  stageSize: StageSize;
  selection: {
    targetId: string;
    bounds: Bounds;
    kind: SelectionKind;
    transform?: {
      translateX: number;
      translateY: number;
    };
  };
  snapTargets?: SnapTarget[];
  onCommit(command: {
    targetId: string;
    before: ElementPatch;
    patch: ElementPatch;
  }): void;
  /** Receives the raw viewport coordinate. Converting it to frame-local space
   * needs the frame element, because a zoomed ancestor is CSS-scaled. */
  onEditAtPoint?(viewportPoint: { x: number; y: number }): void;
}

interface TestDragDetail {
  deltaX: number;
  deltaY: number;
  end: boolean;
}

interface TestResizeDetail {
  direction: number[];
  width: number;
  height: number;
  translateX: number;
  translateY: number;
  end: boolean;
  shiftKey?: boolean;
}

const SNAP_THRESHOLD = 12;
const MIN_SIZE = 8;

export function SelectionOverlay({
  canvasRect,
  stageSize,
  selection,
  snapTargets = [],
  onCommit,
  onEditAtPoint,
}: SelectionOverlayProps) {
  const [proxy, setProxy] = useState<HTMLElement | null>(null);
  const [preview, setPreview] = useState(selection.bounds);
  const [guides, setGuides] = useState<SnapGuide[]>([]);

  useEffect(() => {
    setPreview(selection.bounds);
  }, [selection]);

  const scaleX = canvasRect.width / stageSize.width;
  const scaleY = canvasRect.height / stageSize.height;
  const style = useMemo(
    () => ({
      left: canvasRect.left + preview.x * scaleX,
      top: canvasRect.top + preview.y * scaleY,
      width: preview.width * scaleX,
      height: preview.height * scaleY,
    }),
    [canvasRect.left, canvasRect.top, preview, scaleX, scaleY],
  );

  const descriptor = useCallback(
    (bounds: Bounds): ElementPatch => ({
      translateX:
        (selection.transform?.translateX ?? 0) +
        bounds.x -
        selection.bounds.x,
      translateY:
        (selection.transform?.translateY ?? 0) +
        bounds.y -
        selection.bounds.y,
      width: bounds.width,
      height: selection.kind === "text" ? "auto" : bounds.height,
    }),
    [selection],
  );

  const commit = useCallback(
    (bounds: Bounds) => {
      // Gesto emits dragEnd on every mouseup, so a plain click on the proxy
      // reaches here with the bounds it started from. Committing that would
      // push an empty entry onto the undo stack and, because a patch re-lays
      // out the slide, nudge the element the user only meant to select.
      if (
        bounds.x === selection.bounds.x &&
        bounds.y === selection.bounds.y &&
        bounds.width === selection.bounds.width &&
        bounds.height === selection.bounds.height
      ) {
        return;
      }
      onCommit({
        targetId: selection.targetId,
        before: descriptor(selection.bounds),
        patch: descriptor(bounds),
      });
    },
    [descriptor, onCommit, selection.bounds, selection.targetId],
  );

  const previewDrag = useCallback(
    (deltaX: number, deltaY: number, end: boolean) => {
      const moved = moveBounds(selection.bounds, {
        x: deltaX,
        y: deltaY,
      });
      const snapped = findSnap(
        moved,
        snapTargets,
        SNAP_THRESHOLD,
      );
      setPreview(snapped.bounds);
      setGuides(snapped.guides);
      if (end) commit(snapped.bounds);
    },
    [commit, selection.bounds, snapTargets],
  );

  const previewResize = useCallback(
    (
      deltaX: number,
      deltaY: number,
      handle: ResizeHandle,
      end: boolean,
      shiftKey = false,
    ) => {
      const lockAspectRatio =
        shiftKey ||
        selection.kind === "image" ||
        selection.kind === "svg";
      const resized = resizeBounds(
        selection.bounds,
        { x: deltaX, y: deltaY },
        {
          handle,
          autoHeight: selection.kind === "text",
          lockAspectRatio,
          minWidth: MIN_SIZE,
          minHeight: MIN_SIZE,
        },
      );
      const snapped = findResizeSnap(
        resized,
        snapTargets,
        SNAP_THRESHOLD,
        {
          handle,
          autoHeight: selection.kind === "text",
          lockAspectRatio,
          originalBounds: selection.bounds,
          minWidth: MIN_SIZE,
          minHeight: MIN_SIZE,
        },
      );
      setPreview(snapped.bounds);
      setGuides(snapped.guides);
      if (end) commit(snapped.bounds);
    },
    [commit, selection.bounds, selection.kind, snapTargets],
  );

  useEffect(() => {
    if (!proxy) return;
    const handleTestDrag = (event: Event) => {
      const detail = (event as CustomEvent<TestDragDetail>).detail;
      previewDrag(detail.deltaX, detail.deltaY, detail.end);
    };
    proxy.addEventListener("hse:test-drag", handleTestDrag);
    return () => proxy.removeEventListener("hse:test-drag", handleTestDrag);
  }, [previewDrag, proxy]);

  const previewMoveableResize = useCallback(
    ({
      direction,
      width,
      height,
      translateX,
      translateY,
      end,
      shiftKey = false,
    }: TestResizeDetail) => {
      const handle = directionToHandle(direction);
      if (!handle) return;
      const nextX = selection.bounds.x + translateX / scaleX;
      const nextY = selection.bounds.y + translateY / scaleY;
      const nextWidth = width / scaleX;
      const nextHeight = height / scaleY;
      previewResize(
        handle.includes("w")
          ? nextX - selection.bounds.x
          : handle.includes("e")
            ? nextWidth - selection.bounds.width
            : 0,
        handle.includes("n")
          ? nextY - selection.bounds.y
          : handle.includes("s")
            ? nextHeight - selection.bounds.height
            : 0,
        handle,
        end,
        shiftKey,
      );
    },
    [previewResize, scaleX, scaleY, selection.bounds],
  );

  useEffect(() => {
    if (!proxy) return;
    const handleTestResize = (event: Event) => {
      previewMoveableResize(
        (event as CustomEvent<TestResizeDetail>).detail,
      );
    };
    proxy.addEventListener("hse:test-resize", handleTestResize);
    return () =>
      proxy.removeEventListener("hse:test-resize", handleTestResize);
  }, [previewMoveableResize, proxy]);

  return createPortal(
    <>
      <div
        ref={setProxy}
        data-testid="selection-proxy"
        className="selection-overlay__proxy"
        style={{
          position: "fixed",
          ...style,
        }}
        onDoubleClick={(event) => {
          onEditAtPoint?.({ x: event.clientX, y: event.clientY });
        }}
      />
      {proxy ? (
        <Moveable
          target={proxy}
          draggable
          resizable
          keepRatio={
            selection.kind === "image" || selection.kind === "svg"
          }
          origin={false}
          onDrag={({ beforeTranslate }) => {
            previewDrag(
              beforeTranslate[0] / scaleX,
              beforeTranslate[1] / scaleY,
              false,
            );
          }}
          onDragEnd={({ lastEvent }) => {
            // Gesto emits dragEnd on every mouseup, so a plain click on the
            // proxy lands here with no drag event behind it. Running the drag
            // preview anyway would let findSnap pull the element up to the snap
            // threshold, moving something the user only clicked.
            if (!lastEvent) {
              setPreview(selection.bounds);
              setGuides([]);
              return;
            }
            previewDrag(
              lastEvent.beforeTranslate[0] / scaleX,
              lastEvent.beforeTranslate[1] / scaleY,
              true,
            );
          }}
          onResize={({ direction, drag, width, height, inputEvent }) => {
            previewMoveableResize({
              direction,
              width,
              height,
              translateX: drag.beforeTranslate[0],
              translateY: drag.beforeTranslate[1],
              end: false,
              shiftKey: Boolean(inputEvent?.shiftKey),
            });
          }}
          onResizeEnd={({ lastEvent, inputEvent }) => {
            if (!lastEvent) return;
            previewMoveableResize({
              direction: lastEvent.direction,
              width: lastEvent.width,
              height: lastEvent.height,
              translateX: lastEvent.drag.beforeTranslate[0],
              translateY: lastEvent.drag.beforeTranslate[1],
              end: true,
              shiftKey: Boolean(inputEvent?.shiftKey),
            });
          }}
        />
      ) : null}
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.value}-${guide.kind}`}
          data-testid={`snap-guide-${guide.axis}`}
          className={`selection-overlay__guide selection-overlay__guide--${guide.axis}`}
          style={
            guide.axis === "x"
              ? {
                  position: "fixed",
                  left: canvasRect.left + guide.value * scaleX,
                  top: canvasRect.top,
                  height: canvasRect.height,
                }
              : {
                  position: "fixed",
                  left: canvasRect.left,
                  top: canvasRect.top + guide.value * scaleY,
                  width: canvasRect.width,
                }
          }
        />
      ))}
    </>,
    document.body,
  );
}

function directionToHandle(
  direction: number[],
): ResizeHandle | null {
  const [x, y] = direction;
  const horizontal = x < 0 ? "w" : x > 0 ? "e" : "";
  const vertical = y < 0 ? "n" : y > 0 ? "s" : "";
  const handle = `${vertical}${horizontal}`;
  return handle ? (handle as ResizeHandle) : null;
}
