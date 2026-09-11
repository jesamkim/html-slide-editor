import type { ReactNode } from "react";
import type { StageSize } from "../../core/document/types";

export interface CanvasViewportProps {
  zoom: number;
  stageSize: StageSize;
  children: ReactNode;
}

const MAX_BASE_STAGE_WIDTH = 1120;

export function CanvasViewport({
  zoom,
  stageSize,
  children,
}: CanvasViewportProps) {
  const scale = zoom / 100;

  return (
    <div className="canvas-shell__viewport">
      <div
        className="canvas-shell__stage-sizer"
        style={{
          width: `min(${zoom}%, ${MAX_BASE_STAGE_WIDTH * scale}px)`,
          aspectRatio: `${stageSize.width} / ${stageSize.height}`,
        }}
      >
        <div
          className="canvas-shell__stage"
          style={{
            width: `${100 / scale}%`,
            height: `${100 / scale}%`,
            transform: `scale(${scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
