import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SelectionOverlay } from "./SelectionOverlay";

interface MoveableResizeEvent {
  direction: number[];
  drag: {
    beforeTranslate: number[];
  };
  width: number;
  height: number;
  inputEvent?: {
    shiftKey?: boolean;
  };
}

interface MoveableCallbacks {
  onResize(event: MoveableResizeEvent): void;
  onResizeEnd(event: {
    lastEvent: MoveableResizeEvent;
    inputEvent?: {
      shiftKey?: boolean;
    };
  }): void;
}

const moveable = vi.hoisted(() => ({
  callbacks: null as MoveableCallbacks | null,
}));

vi.mock("react-moveable", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    default: (props: MoveableCallbacks) => {
      moveable.callbacks = props;
      return React.createElement("div", {
        "data-testid": "moveable-callback-probe",
      });
    },
  };
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  moveable.callbacks = null;
});

function readProxyBounds(proxy: HTMLElement) {
  return {
    x: parseFloat(proxy.style.left),
    y: parseFloat(proxy.style.top),
    width: parseFloat(proxy.style.width),
    height: parseFloat(proxy.style.height),
  };
}

const shiftResizeCases = [
  {
    name: "east side",
    direction: [1, 0],
    width: 294,
    height: 100,
    expected: { x: 100, y: 75, width: 300, height: 150 },
  },
  {
    name: "southeast corner",
    direction: [1, 1],
    width: 294,
    height: 130,
    expected: { x: 100, y: 100, width: 300, height: 150 },
  },
];

for (const resizeCase of shiftResizeCases) {
  test(`keeps Shift-locked ${resizeCase.name} preview, guide, and commit identical through Moveable callbacks`, () => {
    const onCommit = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        <SelectionOverlay
          canvasRect={{
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
          }}
          stageSize={{ width: 1920, height: 1080 }}
          selection={{
            targetId: "n1",
            bounds: { x: 100, y: 100, width: 200, height: 100 },
            kind: "container",
          }}
          snapTargets={[
            { axis: "x", value: 400, kind: "stage-end" },
          ]}
          onCommit={onCommit}
        />,
      );
    });
    const proxy = document.querySelector<HTMLElement>(
      "[data-testid='selection-proxy']",
    )!;
    const resizeEvent: MoveableResizeEvent = {
      direction: resizeCase.direction,
      width: resizeCase.width,
      height: resizeCase.height,
      drag: { beforeTranslate: [0, 0] },
      inputEvent: { shiftKey: true },
    };

    flushSync(() => {
      moveable.callbacks!.onResize(resizeEvent);
    });

    const preview = readProxyBounds(proxy);
    expect(preview).toEqual(resizeCase.expected);
    expect(preview.width / preview.height).toBeCloseTo(2, 8);
    expect(
      document.querySelector("[data-testid='snap-guide-x']"),
    ).toHaveStyle({ left: "400px" });
    expect(onCommit).not.toHaveBeenCalled();

    flushSync(() => {
      moveable.callbacks!.onResizeEnd({
        lastEvent: resizeEvent,
        inputEvent: { shiftKey: true },
      });
    });

    expect(onCommit).toHaveBeenCalledOnce();
    const committedPatch = onCommit.mock.calls[0][0].patch;
    const committed = {
      x: 100 + (committedPatch.translateX ?? 0),
      y: 100 + (committedPatch.translateY ?? 0),
      width: committedPatch.width,
      height: committedPatch.height,
    };
    expect(committed).toEqual(preview);
    expect(
      Number(committed.width) / Number(committed.height),
    ).toBeCloseTo(2, 8);
    expect(
      document.querySelector("[data-testid='snap-guide-x']"),
    ).toHaveStyle({ left: "400px" });
  });
}
