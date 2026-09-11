import { expect, test } from "@playwright/test";
import { importDeck, minimalDeckPath } from "./helpers";

test("@layout keeps primary editor regions non-overlapping at 1280x720", async ({
  page,
}) => {
  await importDeck(page, minimalDeckPath, 2);

  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      toolbar: rect(".toolbar"),
      rail: rect(".slide-rail"),
      canvas: rect(".canvas-shell"),
      inspector: rect(".inspector"),
      status: rect(".status-bar"),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(boxes.scrollWidth).toBe(1280);
  expect(boxes.scrollHeight).toBe(720);
  expect(boxes.toolbar.bottom).toBeLessThanOrEqual(boxes.rail.top);
  expect(boxes.rail.right).toBeLessThanOrEqual(boxes.canvas.left);
  expect(boxes.canvas.right).toBeLessThanOrEqual(boxes.inspector.left);
  expect(boxes.rail.bottom).toBeLessThanOrEqual(boxes.status.top);
  expect(boxes.canvas.bottom).toBeLessThanOrEqual(boxes.status.top);
  expect(boxes.inspector.bottom).toBeLessThanOrEqual(boxes.status.top);
});
