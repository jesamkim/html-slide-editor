import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SelectionOverlay } from "./SelectionOverlay";

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

test("forwards a proxy double click as a raw viewport point", () => {
  const onEditAtPoint = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => {
    root!.render(
      <SelectionOverlay
        canvasRect={{ left: 229, top: 228.5, width: 890, height: 500 }}
        stageSize={{ width: 1780, height: 1000 }}
        selection={{
          targetId: "n1",
          bounds: { x: 100, y: 100, width: 1200, height: 600 },
          kind: "container",
        }}
        onCommit={vi.fn()}
        onEditAtPoint={onEditAtPoint}
      />,
    );
  });

  const proxy = document.querySelector<HTMLElement>(
    "[data-testid='selection-proxy']",
  )!;
  flushSync(() => {
    proxy.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: 918,
        clientY: 466,
      }),
    );
  });

  // The overlay must not subtract the canvas offset itself. Converting to
  // frame-local space needs the frame element, because the zoom wrapper
  // CSS-scales an ancestor and getBoundingClientRect is post-transform.
  expect(onEditAtPoint).toHaveBeenCalledTimes(1);
  expect(onEditAtPoint).toHaveBeenCalledWith({ x: 918, y: 466 });
});

test("converts a proxy drag into one snapped stage transform command", async () => {
  const onCommit = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => {
    root!.render(
      <SelectionOverlay
        canvasRect={{ left: 0, top: 0, width: 960, height: 540 }}
        stageSize={{ width: 1920, height: 1080 }}
        selection={{
          targetId: "n1",
          bounds: { x: 900, y: 400, width: 100, height: 100 },
          kind: "text",
        }}
        snapTargets={[
          { axis: "x", value: 960, kind: "stage-center" },
        ]}
        onCommit={onCommit}
      />,
    );
  });

  const proxy = document.querySelector<HTMLElement>(
    "[data-testid='selection-proxy']",
  )!;
  flushSync(() => {
    proxy.dispatchEvent(
      new CustomEvent("hse:test-drag", {
        detail: { deltaX: 0, deltaY: 0, end: false },
      }),
    );
    proxy.dispatchEvent(
      new CustomEvent("hse:test-drag", {
        detail: { deltaX: 0, deltaY: 0, end: true },
      }),
    );
  });

  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith({
    targetId: "n1",
    before: {
      translateX: 0,
      translateY: 0,
      width: 100,
      height: "auto",
    },
    patch: {
      translateX: 10,
      translateY: 0,
      width: 100,
      height: "auto",
    },
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(
    document.querySelector("[data-testid='snap-guide-x']"),
  ).toHaveStyle({ left: "480px" });
});

const resizeCases = [
  {
    handle: "n",
    direction: [0, -1],
    size: [200, 90],
    translate: [0, 10],
    expected: { translateX: 0, translateY: 10, width: 200, height: 90 },
  },
  {
    handle: "ne",
    direction: [1, -1],
    size: [220, 90],
    translate: [0, 10],
    expected: { translateX: 0, translateY: 10, width: 220, height: 90 },
  },
  {
    handle: "e",
    direction: [1, 0],
    size: [220, 100],
    translate: [0, 0],
    expected: { translateX: 0, translateY: 0, width: 220, height: 100 },
  },
  {
    handle: "se",
    direction: [1, 1],
    size: [220, 110],
    translate: [0, 0],
    expected: { translateX: 0, translateY: 0, width: 220, height: 110 },
  },
  {
    handle: "s",
    direction: [0, 1],
    size: [200, 110],
    translate: [0, 0],
    expected: { translateX: 0, translateY: 0, width: 200, height: 110 },
  },
  {
    handle: "sw",
    direction: [-1, 1],
    size: [180, 110],
    translate: [20, 0],
    expected: { translateX: 20, translateY: 0, width: 180, height: 110 },
  },
  {
    handle: "w",
    direction: [-1, 0],
    size: [180, 100],
    translate: [20, 0],
    expected: { translateX: 20, translateY: 0, width: 180, height: 100 },
  },
  {
    handle: "nw",
    direction: [-1, -1],
    size: [180, 90],
    translate: [20, 10],
    expected: { translateX: 20, translateY: 10, width: 180, height: 90 },
  },
];

for (const zoom of [50, 100, 200]) {
  for (const resizeCase of resizeCases) {
    test(`resizes ${resizeCase.handle} correctly at ${zoom}% zoom`, () => {
      const onCommit = vi.fn();
      const scale = zoom / 100;
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      flushSync(() => {
        root!.render(
          <SelectionOverlay
            canvasRect={{
              left: 0,
              top: 0,
              width: 1920 * scale,
              height: 1080 * scale,
            }}
            stageSize={{ width: 1920, height: 1080 }}
            selection={{
              targetId: "n1",
              bounds: { x: 100, y: 100, width: 200, height: 100 },
              kind: "container",
            }}
            onCommit={onCommit}
          />,
        );
      });
      const proxy = document.querySelector<HTMLElement>(
        "[data-testid='selection-proxy']",
      )!;

      proxy.dispatchEvent(
        new CustomEvent("hse:test-resize", {
          detail: {
            direction: resizeCase.direction,
            width: resizeCase.size[0] * scale,
            height: resizeCase.size[1] * scale,
            translateX: resizeCase.translate[0] * scale,
            translateY: resizeCase.translate[1] * scale,
            end: true,
          },
        }),
      );

      expect(onCommit).toHaveBeenCalledOnce();
      expect(onCommit).toHaveBeenCalledWith({
        targetId: "n1",
        before: {
          translateX: 0,
          translateY: 0,
          width: 200,
          height: 100,
        },
        patch: resizeCase.expected,
      });
    });
  }
}

const resizeSnapCases = [
  {
    name: "west edge to sibling target",
    zoom: 50,
    direction: [-1, 0],
    size: [186, 100],
    translate: [14, 0],
    snapTargets: [
      { axis: "x" as const, value: 120, kind: "object-start" },
      { axis: "y" as const, value: 150, kind: "object-center" },
    ],
    expectedStyle: { left: "60px", top: "50px", width: "90px", height: "50px" },
    expectedPatch: {
      translateX: 20,
      translateY: 0,
      width: 180,
      height: 100,
    },
    guideAxis: "x",
    guidePosition: { left: "60px" },
  },
  {
    name: "north edge to stage target",
    zoom: 150,
    direction: [0, -1],
    size: [200, 194],
    translate: [0, -94],
    snapTargets: [
      { axis: "y" as const, value: 0, kind: "stage-start" },
      { axis: "x" as const, value: 200, kind: "stage-center" },
    ],
    expectedStyle: {
      left: "150px",
      top: "0px",
      width: "300px",
      height: "300px",
    },
    expectedPatch: {
      translateX: 0,
      translateY: -100,
      width: 200,
      height: 200,
    },
    guideAxis: "y",
    guidePosition: { top: "0px" },
  },
  {
    name: "east edge to stage target",
    zoom: 50,
    direction: [1, 0],
    size: [294, 100],
    translate: [0, 0],
    snapTargets: [
      { axis: "x" as const, value: 400, kind: "stage-end" },
      { axis: "y" as const, value: 150, kind: "stage-center" },
    ],
    expectedStyle: {
      left: "50px",
      top: "50px",
      width: "150px",
      height: "50px",
    },
    expectedPatch: {
      translateX: 0,
      translateY: 0,
      width: 300,
      height: 100,
    },
    guideAxis: "x",
    guidePosition: { left: "200px" },
  },
  {
    name: "south edge to sibling target",
    zoom: 150,
    direction: [0, 1],
    size: [200, 144],
    translate: [0, 0],
    snapTargets: [
      { axis: "y" as const, value: 250, kind: "object-end" },
      { axis: "x" as const, value: 200, kind: "object-center" },
    ],
    expectedStyle: {
      left: "150px",
      top: "150px",
      width: "300px",
      height: "225px",
    },
    expectedPatch: {
      translateX: 0,
      translateY: 0,
      width: 200,
      height: 150,
    },
    guideAxis: "y",
    guidePosition: { top: "375px" },
  },
];

for (const snapCase of resizeSnapCases) {
  test(`snaps ${snapCase.name} at ${snapCase.zoom}% zoom`, () => {
    const onCommit = vi.fn();
    const scale = snapCase.zoom / 100;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        <SelectionOverlay
          canvasRect={{
            left: 0,
            top: 0,
            width: 1920 * scale,
            height: 1080 * scale,
          }}
          stageSize={{ width: 1920, height: 1080 }}
          selection={{
            targetId: "n1",
            bounds: { x: 100, y: 100, width: 200, height: 100 },
            kind: "container",
          }}
          snapTargets={snapCase.snapTargets}
          onCommit={onCommit}
        />,
      );
    });
    const proxy = document.querySelector<HTMLElement>(
      "[data-testid='selection-proxy']",
    )!;
    const detail = {
      direction: snapCase.direction,
      width: snapCase.size[0] * scale,
      height: snapCase.size[1] * scale,
      translateX: snapCase.translate[0] * scale,
      translateY: snapCase.translate[1] * scale,
    };

    flushSync(() => {
      proxy.dispatchEvent(
        new CustomEvent("hse:test-resize", {
          detail: { ...detail, end: false },
        }),
      );
    });

    expect(proxy).toHaveStyle(snapCase.expectedStyle);
    expect(
      document.querySelector(
        `[data-testid='snap-guide-${snapCase.guideAxis}']`,
      ),
    ).toHaveStyle(snapCase.guidePosition);
    expect(
      document.querySelector(
        `[data-testid='snap-guide-${
          snapCase.guideAxis === "x" ? "y" : "x"
        }']`,
      ),
    ).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();

    flushSync(() => {
      proxy.dispatchEvent(
        new CustomEvent("hse:test-resize", {
          detail: { ...detail, end: true },
        }),
      );
    });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      targetId: "n1",
      before: {
        translateX: 0,
        translateY: 0,
        width: 200,
        height: 100,
      },
      patch: snapCase.expectedPatch,
    });
  });
}

const aspectSnapCases = [
  {
    name: "image east side keeps vertical center",
    zoom: 50,
    kind: "image" as const,
    shiftKey: false,
    direction: [1, 0],
    resized: { x: 100, y: 76.5, width: 294, height: 147 },
    snapTarget: { axis: "x" as const, value: 400, kind: "stage-end" },
    expected: { x: 100, y: 75, width: 300, height: 150 },
    guideAxis: "x",
    invariant: { type: "center-y" as const, value: 150 },
  },
  {
    name: "svg west side keeps vertical center",
    zoom: 150,
    kind: "svg" as const,
    shiftKey: false,
    direction: [-1, 0],
    resized: { x: 6, y: 76.5, width: 294, height: 147 },
    snapTarget: { axis: "x" as const, value: 0, kind: "stage-start" },
    expected: { x: 0, y: 75, width: 300, height: 150 },
    guideAxis: "x",
    invariant: { type: "center-y" as const, value: 150 },
  },
  {
    name: "shift north side keeps horizontal center",
    zoom: 50,
    kind: "container" as const,
    shiftKey: true,
    direction: [0, -1],
    resized: { x: 6, y: 6, width: 388, height: 194 },
    snapTarget: { axis: "y" as const, value: 0, kind: "stage-start" },
    expected: { x: 0, y: 0, width: 400, height: 200 },
    guideAxis: "y",
    invariant: { type: "center-x" as const, value: 200 },
  },
  {
    name: "image south side keeps horizontal center",
    zoom: 150,
    kind: "image" as const,
    shiftKey: false,
    direction: [0, 1],
    resized: { x: 6, y: 100, width: 388, height: 194 },
    snapTarget: { axis: "y" as const, value: 300, kind: "object-end" },
    expected: { x: 0, y: 100, width: 400, height: 200 },
    guideAxis: "y",
    invariant: { type: "center-x" as const, value: 200 },
  },
  {
    name: "shift southeast corner keeps top-left fixed",
    zoom: 50,
    kind: "container" as const,
    shiftKey: true,
    direction: [1, 1],
    resized: { x: 100, y: 100, width: 294, height: 147 },
    snapTarget: { axis: "x" as const, value: 400, kind: "stage-end" },
    expected: { x: 100, y: 100, width: 300, height: 150 },
    guideAxis: "x",
    invariant: { type: "top-left" as const, value: [100, 100] },
  },
  {
    name: "svg northwest corner keeps bottom-right fixed",
    zoom: 150,
    kind: "svg" as const,
    shiftKey: false,
    direction: [-1, -1],
    resized: { x: 6, y: 53, width: 294, height: 147 },
    snapTarget: { axis: "y" as const, value: 50, kind: "object-start" },
    expected: { x: 0, y: 50, width: 300, height: 150 },
    guideAxis: "y",
    invariant: { type: "bottom-right" as const, value: [300, 200] },
  },
];

for (const snapCase of aspectSnapCases) {
  test(`preserves aspect ratio when snapping ${snapCase.name} at ${snapCase.zoom}%`, () => {
    const onCommit = vi.fn();
    const scale = snapCase.zoom / 100;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        <SelectionOverlay
          canvasRect={{
            left: 0,
            top: 0,
            width: 1920 * scale,
            height: 1080 * scale,
          }}
          stageSize={{ width: 1920, height: 1080 }}
          selection={{
            targetId: "n1",
            bounds: { x: 100, y: 100, width: 200, height: 100 },
            kind: snapCase.kind,
          }}
          snapTargets={[snapCase.snapTarget]}
          onCommit={onCommit}
        />,
      );
    });
    const proxy = document.querySelector<HTMLElement>(
      "[data-testid='selection-proxy']",
    )!;
    const detail = {
      direction: snapCase.direction,
      width: snapCase.resized.width * scale,
      height: snapCase.resized.height * scale,
      translateX: (snapCase.resized.x - 100) * scale,
      translateY: (snapCase.resized.y - 100) * scale,
      shiftKey: snapCase.shiftKey,
    };

    flushSync(() => {
      proxy.dispatchEvent(
        new CustomEvent("hse:test-resize", {
          detail: { ...detail, end: false },
        }),
      );
    });

    const preview = {
      x: parseFloat(proxy.style.left) / scale,
      y: parseFloat(proxy.style.top) / scale,
      width: parseFloat(proxy.style.width) / scale,
      height: parseFloat(proxy.style.height) / scale,
    };
    expect(preview).toEqual(snapCase.expected);
    expect(preview.width / preview.height).toBeCloseTo(2, 8);
    if (snapCase.invariant.type === "center-y") {
      expect(preview.y + preview.height / 2).toBe(
        snapCase.invariant.value,
      );
    } else if (snapCase.invariant.type === "center-x") {
      expect(preview.x + preview.width / 2).toBe(
        snapCase.invariant.value,
      );
    } else if (snapCase.invariant.type === "top-left") {
      expect([preview.x, preview.y]).toEqual(snapCase.invariant.value);
    } else {
      expect([
        preview.x + preview.width,
        preview.y + preview.height,
      ]).toEqual(snapCase.invariant.value);
    }
    expect(
      document.querySelector(
        `[data-testid='snap-guide-${snapCase.guideAxis}']`,
      ),
    ).not.toBeNull();

    flushSync(() => {
      proxy.dispatchEvent(
        new CustomEvent("hse:test-resize", {
          detail: { ...detail, end: true },
        }),
      );
    });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      targetId: "n1",
      before: {
        translateX: 0,
        translateY: 0,
        width: 200,
        height: 100,
      },
      patch: {
        translateX: snapCase.expected.x - 100,
        translateY: snapCase.expected.y - 100,
        width: snapCase.expected.width,
        height: snapCase.expected.height,
      },
    });
  });
}
