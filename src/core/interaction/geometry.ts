import type { Bounds, Point, StageSize } from "../document/types";

export type ResizeHandle =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

export interface ResizeOptions {
  handle: ResizeHandle;
  lockAspectRatio?: boolean;
  autoHeight?: boolean;
  minWidth?: number;
  minHeight?: number;
}

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SnapTarget {
  axis: "x" | "y";
  value: number;
  kind: string;
}

export type SnapAnchor = "start" | "center" | "end";

export interface SnapGuide extends SnapTarget {
  anchor: SnapAnchor;
}

export interface SnapResult {
  bounds: Bounds;
  deltaX: number;
  deltaY: number;
  guides: SnapGuide[];
}

export function toStagePoint(
  client: Point,
  canvas: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">,
  stage: StageSize,
): Point {
  if (
    !Number.isFinite(canvas.width) ||
    !Number.isFinite(canvas.height) ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    throw new RangeError("Canvas dimensions must be positive and finite");
  }

  return {
    x: ((client.x - canvas.left) / canvas.width) * stage.width,
    y: ((client.y - canvas.top) / canvas.height) * stage.height,
  };
}

export function moveBounds(bounds: Bounds, delta: Point): Bounds {
  return {
    x: bounds.x + delta.x,
    y: bounds.y + delta.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function resizeBounds(
  bounds: Bounds,
  delta: Point,
  options: ResizeOptions,
): Bounds {
  const minWidth = Math.max(0, options.minWidth ?? 0);
  const minHeight = Math.max(0, options.minHeight ?? 0);

  if (
    options.lockAspectRatio &&
    !options.autoHeight &&
    bounds.width > 0 &&
    bounds.height > 0
  ) {
    return resizeWithAspectLock(
      bounds,
      delta,
      options.handle,
      minWidth,
      minHeight,
    );
  }

  return resizeFreely(
    bounds,
    delta,
    options.handle,
    minWidth,
    minHeight,
    options.autoHeight ?? false,
  );
}

export function keyboardDelta(
  key: ArrowKey,
  accelerated = false,
): Point {
  const distance = accelerated ? 10 : 1;

  switch (key) {
    case "ArrowLeft":
      return { x: -distance, y: 0 };
    case "ArrowRight":
      return { x: distance, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -distance };
    case "ArrowDown":
      return { x: 0, y: distance };
  }
}

export function findSnap(
  bounds: Bounds,
  targets: SnapTarget[],
  threshold: number,
): SnapResult {
  const normalizedThreshold =
    Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  const xSnap = findAxisSnap(bounds, targets, "x", normalizedThreshold);
  const ySnap = findAxisSnap(bounds, targets, "y", normalizedThreshold);
  const deltaX = xSnap?.delta ?? 0;
  const deltaY = ySnap?.delta ?? 0;
  const guides = [xSnap?.guide, ySnap?.guide].filter(
    (guide): guide is SnapGuide => guide !== undefined,
  );

  return {
    bounds: moveBounds(bounds, { x: deltaX, y: deltaY }),
    deltaX,
    deltaY,
    guides,
  };
}

export function findResizeSnap(
  bounds: Bounds,
  targets: SnapTarget[],
  threshold: number,
  options: Pick<
    ResizeOptions,
    | "handle"
    | "autoHeight"
    | "lockAspectRatio"
    | "minWidth"
    | "minHeight"
  > & { originalBounds?: Bounds },
): SnapResult {
  const normalizedThreshold =
    Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  const minWidth = Math.max(0, options.minWidth ?? 0);
  const minHeight = Math.max(0, options.minHeight ?? 0);
  const movesWest = options.handle.includes("w");
  const movesEast = options.handle.includes("e");
  const movesNorth =
    !options.autoHeight && options.handle.includes("n");
  const movesSouth =
    !options.autoHeight && options.handle.includes("s");
  const xSnap =
    movesWest || movesEast
      ? findControlledEdgeSnap(
          bounds,
          targets,
          "x",
          movesWest ? "start" : "end",
          normalizedThreshold,
        )
      : undefined;
  const ySnap =
    movesNorth || movesSouth
      ? findControlledEdgeSnap(
          bounds,
          targets,
          "y",
          movesNorth ? "start" : "end",
          normalizedThreshold,
        )
      : undefined;

  const original = options.originalBounds ?? bounds;
  if (
    options.lockAspectRatio &&
    !options.autoHeight &&
    original.width > 0 &&
    original.height > 0
  ) {
    return applyAspectLockedResizeSnap({
      bounds,
      original,
      movesWest,
      movesEast,
      movesNorth,
      movesSouth,
      xSnap,
      ySnap,
      minWidth,
      minHeight,
    });
  }

  let next = { ...bounds };
  const guides: SnapGuide[] = [];
  let deltaX = 0;
  let deltaY = 0;

  if (xSnap) {
    const width = next.width + (movesWest ? -xSnap.delta : xSnap.delta);
    if (width >= minWidth) {
      deltaX = xSnap.delta;
      next = {
        ...next,
        x: movesWest ? next.x + xSnap.delta : next.x,
        width,
      };
      guides.push(xSnap.guide);
    }
  }
  if (ySnap) {
    const height =
      next.height + (movesNorth ? -ySnap.delta : ySnap.delta);
    if (height >= minHeight) {
      deltaY = ySnap.delta;
      next = {
        ...next,
        y: movesNorth ? next.y + ySnap.delta : next.y,
        height,
      };
      guides.push(ySnap.guide);
    }
  }

  return {
    bounds: next,
    deltaX,
    deltaY,
    guides,
  };
}

function resizeFreely(
  bounds: Bounds,
  delta: Point,
  handle: ResizeHandle,
  minWidth: number,
  minHeight: number,
  autoHeight: boolean,
): Bounds {
  const movesWest = handle.includes("w");
  const movesEast = handle.includes("e");
  const movesNorth = !autoHeight && handle.includes("n");
  const movesSouth = !autoHeight && handle.includes("s");
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  let width = bounds.width;
  if (movesWest) width = Math.max(minWidth, bounds.width - delta.x);
  if (movesEast) width = Math.max(minWidth, bounds.width + delta.x);

  let height = bounds.height;
  if (movesNorth) height = Math.max(minHeight, bounds.height - delta.y);
  if (movesSouth) height = Math.max(minHeight, bounds.height + delta.y);

  return {
    x: movesWest ? right - width : bounds.x,
    y: movesNorth ? bottom - height : bounds.y,
    width,
    height,
  };
}

function resizeWithAspectLock(
  bounds: Bounds,
  delta: Point,
  handle: ResizeHandle,
  minWidth: number,
  minHeight: number,
): Bounds {
  const movesWest = handle.includes("w");
  const movesEast = handle.includes("e");
  const movesNorth = handle.includes("n");
  const movesSouth = handle.includes("s");
  const horizontal = movesWest || movesEast;
  const vertical = movesNorth || movesSouth;

  const desiredWidth =
    bounds.width + (movesWest ? -delta.x : movesEast ? delta.x : 0);
  const desiredHeight =
    bounds.height + (movesNorth ? -delta.y : movesSouth ? delta.y : 0);
  const widthScale = desiredWidth / bounds.width;
  const heightScale = desiredHeight / bounds.height;

  let scale: number;
  if (horizontal && vertical) {
    scale =
      Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)
        ? widthScale
        : heightScale;
  } else {
    scale = horizontal ? widthScale : heightScale;
  }

  const minimumScale = Math.max(
    minWidth / bounds.width,
    minHeight / bounds.height,
    0,
  );
  scale = Math.max(minimumScale, scale);

  const width = bounds.width * scale;
  const height = bounds.height * scale;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  return {
    x: movesWest
      ? right - width
      : horizontal
        ? bounds.x
        : bounds.x + (bounds.width - width) / 2,
    y: movesNorth
      ? bottom - height
      : vertical
        ? bounds.y
        : bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}

function findAxisSnap(
  bounds: Bounds,
  targets: SnapTarget[],
  axis: "x" | "y",
  threshold: number,
): { delta: number; guide: SnapGuide } | undefined {
  const start = axis === "x" ? bounds.x : bounds.y;
  const size = axis === "x" ? bounds.width : bounds.height;
  const anchors: Array<{ anchor: SnapAnchor; value: number }> = [
    { anchor: "start", value: start },
    { anchor: "center", value: start + size / 2 },
    { anchor: "end", value: start + size },
  ];

  let nearest:
    | { distance: number; delta: number; guide: SnapGuide }
    | undefined;

  for (const target of targets) {
    if (target.axis !== axis || !Number.isFinite(target.value)) continue;

    for (const anchor of anchors) {
      const delta = target.value - anchor.value;
      const distance = Math.abs(delta);
      if (
        distance <= threshold &&
        (nearest === undefined || distance < nearest.distance)
      ) {
        nearest = {
          distance,
          delta,
          guide: {
            axis,
            value: target.value,
            kind: target.kind,
            anchor: anchor.anchor,
          },
        };
      }
    }
  }

  return nearest;
}

function findControlledEdgeSnap(
  bounds: Bounds,
  targets: SnapTarget[],
  axis: "x" | "y",
  anchor: "start" | "end",
  threshold: number,
): { distance: number; delta: number; guide: SnapGuide } | undefined {
  const start = axis === "x" ? bounds.x : bounds.y;
  const size = axis === "x" ? bounds.width : bounds.height;
  const value = anchor === "start" ? start : start + size;
  let nearest:
    | { distance: number; delta: number; guide: SnapGuide }
    | undefined;

  for (const target of targets) {
    if (target.axis !== axis || !Number.isFinite(target.value)) continue;
    const delta = target.value - value;
    const distance = Math.abs(delta);
    if (
      distance <= threshold &&
      (nearest === undefined || distance < nearest.distance)
    ) {
      nearest = {
        distance,
        delta,
        guide: {
          ...target,
          anchor,
        },
      };
    }
  }

  return nearest;
}

function applyAspectLockedResizeSnap({
  bounds,
  original,
  movesWest,
  movesEast,
  movesNorth,
  movesSouth,
  xSnap,
  ySnap,
  minWidth,
  minHeight,
}: {
  bounds: Bounds;
  original: Bounds;
  movesWest: boolean;
  movesEast: boolean;
  movesNorth: boolean;
  movesSouth: boolean;
  xSnap?: { distance: number; delta: number; guide: SnapGuide };
  ySnap?: { distance: number; delta: number; guide: SnapGuide };
  minWidth: number;
  minHeight: number;
}): SnapResult {
  const horizontal = movesWest || movesEast;
  const vertical = movesNorth || movesSouth;
  const right = original.x + original.width;
  const bottom = original.y + original.height;
  const centerX = original.x + original.width / 2;
  const centerY = original.y + original.height / 2;
  const minimumScale = Math.max(
    minWidth / original.width,
    minHeight / original.height,
    0,
  );
  const candidates: Array<{
    axis: "x" | "y";
    distance: number;
    delta: number;
    guide: SnapGuide;
    scale: number;
  }> = [];

  if (xSnap && horizontal) {
    const target = xSnap.guide.value;
    const width = movesWest ? right - target : target - original.x;
    candidates.push({
      axis: "x",
      ...xSnap,
      scale: width / original.width,
    });
  }
  if (ySnap && vertical) {
    const target = ySnap.guide.value;
    const height = movesNorth ? bottom - target : target - original.y;
    candidates.push({
      axis: "y",
      ...ySnap,
      scale: height / original.height,
    });
  }

  const valid = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.scale) &&
      candidate.scale >= minimumScale,
  );
  if (valid.length === 0) {
    return {
      bounds,
      deltaX: 0,
      deltaY: 0,
      guides: [],
    };
  }
  const chosen = valid.reduce((nearest, candidate) =>
    candidate.distance < nearest.distance ? candidate : nearest,
  );
  const width = original.width * chosen.scale;
  const height = original.height * chosen.scale;
  const isSide = horizontal !== vertical;
  const snapped = {
    x: movesWest
      ? right - width
      : isSide && vertical
        ? centerX - width / 2
        : original.x,
    y: movesNorth
      ? bottom - height
      : isSide && horizontal
        ? centerY - height / 2
        : original.y,
    width,
    height,
  };

  return {
    bounds: snapped,
    deltaX: chosen.axis === "x" ? chosen.delta : 0,
    deltaY: chosen.axis === "y" ? chosen.delta : 0,
    guides: [chosen.guide],
  };
}
