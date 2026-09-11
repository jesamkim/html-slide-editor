import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import "../../styles.css";
import { CanvasViewport } from "./CanvasViewport";

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

test("keeps all slide edges reachable in a scrollable canvas at 200 percent", async () => {
  host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:640px;height:360px";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => {
    root!.render(
      <section
        aria-label="슬라이드 캔버스"
        className="canvas-shell"
        style={{ width: "640px", height: "360px" }}
      >
        <CanvasViewport
          zoom={200}
          stageSize={{ width: 1920, height: 1080 }}
        >
          <div className="canvas-shell__frame" />
        </CanvasViewport>
      </section>,
    );
  });
  await nextFrame();

  const canvas = host.querySelector<HTMLElement>(".canvas-shell")!;
  const sizer = host.querySelector<HTMLElement>(
    ".canvas-shell__stage-sizer",
  )!;
  const stage = host.querySelector<HTMLElement>(".canvas-shell__stage")!;
  const canvasRect = canvas.getBoundingClientRect();
  const initialStageRect = stage.getBoundingClientRect();
  const sizerRect = sizer.getBoundingClientRect();

  expect(canvas.scrollWidth).toBeGreaterThan(canvas.clientWidth);
  expect(canvas.scrollHeight).toBeGreaterThan(canvas.clientHeight);
  expect(initialStageRect.left).toBeGreaterThanOrEqual(canvasRect.left);
  expect(initialStageRect.top).toBeGreaterThanOrEqual(canvasRect.top);
  expect(initialStageRect.width).toBeCloseTo(sizerRect.width, 1);
  expect(initialStageRect.height).toBeCloseTo(sizerRect.height, 1);

  canvas.scrollLeft = canvas.scrollWidth - canvas.clientWidth;
  canvas.scrollTop = canvas.scrollHeight - canvas.clientHeight;
  await nextFrame();

  const finalStageRect = stage.getBoundingClientRect();
  expect(finalStageRect.right).toBeLessThanOrEqual(canvasRect.right + 1);
  expect(finalStageRect.bottom).toBeLessThanOrEqual(canvasRect.bottom + 1);
});
