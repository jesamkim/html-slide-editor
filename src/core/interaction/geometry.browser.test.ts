import { expect, test } from "vitest";
import { toStagePoint } from "./geometry";

test("uses a real scaled canvas rectangle", () => {
  const canvas = document.createElement("div");
  canvas.style.cssText =
    "position:fixed;left:137px;top:83px;width:960px;height:540px";
  document.body.append(canvas);

  try {
    const rect = canvas.getBoundingClientRect();

    expect(rect.width).toBe(960);
    expect(rect.height).toBe(540);
    expect(rect.left).toBe(137);
    expect(rect.top).toBe(83);
    expect(
      toStagePoint(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        rect,
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 960, y: 540 });
  } finally {
    canvas.remove();
  }
});
