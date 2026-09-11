import { describe, expect, it } from "vitest";
import {
  findSnap,
  keyboardDelta,
  moveBounds,
  resizeBounds,
  toStagePoint,
} from "./geometry";

describe("stage coordinate conversion", () => {
  it("maps scaled browser coordinates to stage coordinates", () => {
    expect(
      toStagePoint(
        { x: 640, y: 360 },
        { left: 0, top: 0, width: 1280, height: 720 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 960, y: 540 });
  });

  it.each([
    { width: 0, height: 540 },
    { width: 960, height: 0 },
    { width: -1, height: 540 },
    { width: 960, height: -1 },
    { width: Number.NaN, height: 540 },
    { width: 960, height: Number.POSITIVE_INFINITY },
  ])(
    "rejects a zero-sized canvas rectangle without returning non-finite values",
    (canvas) => {
      expect(() =>
        toStagePoint(
          { x: 480, y: 270 },
          { left: 0, top: 0, ...canvas },
          { width: 1920, height: 1080 },
        ),
      ).toThrowError(RangeError);
    },
  );
});

describe("bounds movement", () => {
  it("moves position without changing size or mutating the source", () => {
    const bounds = { x: 100, y: 200, width: 300, height: 120 };

    expect(moveBounds(bounds, { x: -20, y: 15 })).toEqual({
      x: 80,
      y: 215,
      width: 300,
      height: 120,
    });
    expect(bounds).toEqual({ x: 100, y: 200, width: 300, height: 120 });
  });
});

describe("bounds resizing", () => {
  const bounds = { x: 100, y: 200, width: 300, height: 120 };

  it.each([
    [
      "n" as const,
      { x: 40, y: 20 },
      { x: 100, y: 220, width: 300, height: 100 },
    ],
    [
      "e" as const,
      { x: 40, y: 20 },
      { x: 100, y: 200, width: 340, height: 120 },
    ],
    [
      "s" as const,
      { x: 40, y: 20 },
      { x: 100, y: 200, width: 300, height: 140 },
    ],
    [
      "w" as const,
      { x: 40, y: 20 },
      { x: 140, y: 200, width: 260, height: 120 },
    ],
    [
      "ne" as const,
      { x: 40, y: 20 },
      { x: 100, y: 220, width: 340, height: 100 },
    ],
    [
      "se" as const,
      { x: 40, y: 20 },
      { x: 100, y: 200, width: 340, height: 140 },
    ],
    [
      "sw" as const,
      { x: 40, y: 20 },
      { x: 140, y: 200, width: 260, height: 140 },
    ],
    [
      "nw" as const,
      { x: 40, y: 20 },
      { x: 140, y: 220, width: 260, height: 100 },
    ],
  ])("resizes the %s handle while keeping its opposite edges fixed", (
    handle,
    delta,
    expected,
  ) => {
    expect(resizeBounds(bounds, delta, { handle })).toEqual(expected);
  });

  it("clamps a side resize to the requested minimum size", () => {
    expect(
      resizeBounds(bounds, { x: 500, y: 0 }, {
        handle: "w",
        minWidth: 40,
      }),
    ).toEqual({ x: 360, y: 200, width: 40, height: 120 });
  });

  it("locks a side resize to the original aspect ratio around the center", () => {
    expect(
      resizeBounds(bounds, { x: 150, y: 0 }, {
        handle: "e",
        lockAspectRatio: true,
      }),
    ).toEqual({ x: 100, y: 170, width: 450, height: 180 });
  });

  it("locks a corner resize to the dominant relative delta", () => {
    expect(
      resizeBounds(bounds, { x: 30, y: 60 }, {
        handle: "se",
        lockAspectRatio: true,
      }),
    ).toEqual({ x: 100, y: 200, width: 450, height: 180 });
  });

  it.each([
    [
      "ne" as const,
      { x: 60, y: -12 },
      { x: 100, y: 176, width: 360, height: 144 },
    ],
    [
      "sw" as const,
      { x: -60, y: 12 },
      { x: 40, y: 200, width: 360, height: 144 },
    ],
  ])("preserves aspect ratio for the %s corner", (handle, delta, expected) => {
    expect(
      resizeBounds(bounds, delta, {
        handle,
        lockAspectRatio: true,
      }),
    ).toEqual(expected);
  });

  it("resizes text width while preserving its measured auto height", () => {
    expect(
      resizeBounds(bounds, { x: 40, y: 80 }, {
        handle: "se",
        autoHeight: true,
      }),
    ).toEqual({ x: 100, y: 200, width: 340, height: 120 });
  });

  it("keeps aspect-lock output finite for a zero-sized source", () => {
    const result = resizeBounds(
      { x: 10, y: 20, width: 0, height: 0 },
      { x: 5, y: 7 },
      { handle: "se", lockAspectRatio: true },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 5, height: 7 });
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
  });
});

describe("keyboard movement", () => {
  it.each([
    ["ArrowLeft" as const, false, { x: -1, y: 0 }],
    ["ArrowRight" as const, true, { x: 10, y: 0 }],
    ["ArrowUp" as const, false, { x: 0, y: -1 }],
    ["ArrowDown" as const, true, { x: 0, y: 10 }],
  ])("maps %s with accelerated=%s to the expected delta", (
    key,
    accelerated,
    expected,
  ) => {
    expect(keyboardDelta(key, accelerated)).toEqual(expected);
  });
});

describe("snapping", () => {
  it("snaps an object center to the stage center and returns its guide", () => {
    const result = findSnap(
      { x: 900, y: 400, width: 100, height: 100 },
      [{ axis: "x", value: 960, kind: "stage-center" }],
      12,
    );

    expect(result).toEqual({
      bounds: { x: 910, y: 400, width: 100, height: 100 },
      deltaX: 10,
      deltaY: 0,
      guides: [
        {
          axis: "x",
          value: 960,
          kind: "stage-center",
          anchor: "center",
        },
      ],
    });
  });

  it("chooses the nearest snap independently on each axis", () => {
    const result = findSnap(
      { x: 98, y: 203, width: 100, height: 50 },
      [
        { axis: "x", value: 100, kind: "object-start" },
        { axis: "x", value: 205, kind: "object-end" },
        { axis: "y", value: 200, kind: "object-start" },
      ],
      8,
    );

    expect(result.deltaX).toBe(2);
    expect(result.deltaY).toBe(-3);
    expect(result.bounds).toEqual({
      x: 100,
      y: 200,
      width: 100,
      height: 50,
    });
    expect(result.guides).toEqual([
      {
        axis: "x",
        value: 100,
        kind: "object-start",
        anchor: "start",
      },
      {
        axis: "y",
        value: 200,
        kind: "object-start",
        anchor: "start",
      },
    ]);
  });

  it("uses target order as a stable tie-breaker", () => {
    const result = findSnap(
      { x: 100, y: 50, width: 20, height: 20 },
      [
        { axis: "x", value: 99, kind: "first" },
        { axis: "x", value: 101, kind: "second" },
      ],
      2,
    );

    expect(result.deltaX).toBe(-1);
    expect(result.guides[0]).toMatchObject({ value: 99, kind: "first" });
  });

  it("does not snap when the nearest target is beyond the threshold", () => {
    const bounds = { x: 100, y: 50, width: 20, height: 20 };

    expect(
      findSnap(
        bounds,
        [{ axis: "x", value: 95, kind: "object-start" }],
        4,
      ),
    ).toEqual({
      bounds,
      deltaX: 0,
      deltaY: 0,
      guides: [],
    });
  });
});
