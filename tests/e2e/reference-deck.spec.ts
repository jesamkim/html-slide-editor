import { expect, test } from "@playwright/test";
import {
  activateSlide,
  downloadDeck,
  editorFrame,
  expectNonBlankPixels,
  importDeck,
  openDownloadedDeck,
  referenceDeckPath,
  reorderSlide,
  selectThenEdit,
  slideItems,
} from "./helpers";

test("round-trips the 22-slide reference deck with representative visuals", async ({
  page,
}, testInfo) => {
  await importDeck(page, referenceDeckPath, 22);
  await expect(slideItems(page)).toHaveCount(22);
  const frame = editorFrame(page);

  // The bridge ships as text from Function.prototype.toString(), so a minified
  // build can break it in ways the dev server never shows. A live deck error
  // here means the injected script did not run.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "HTML 내보내기" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "슬라이드 8 선택" }),
  ).toBeEnabled();

  for (const [slideNumber, slideId] of [
    [6, "personas"],
    [7, "s6"],
    [9, "s7"],
    [18, "s10"],
    [20, "consumer-patterns"],
  ] as const) {
    await page
      .getByRole("button", { name: `슬라이드 ${slideNumber} 선택` })
      .click();
    const active = frame.locator(`#${slideId}`);
    await expect(active).toHaveClass(/active/);
    const steps = active.locator("[data-step]");
    await expect.poll(() => steps.count()).toBeGreaterThan(0);
    expect(
      await steps.evaluateAll((elements) =>
        elements.every((element) => element.classList.contains("revealed")),
      ),
    ).toBe(true);
    await expect(steps.first()).toBeVisible();
  }

  await page.getByRole("button", { name: "슬라이드 8 선택" }).click();
  const bodyCopy = frame.getByText(
    "This paragraph can be edited directly in the canvas.",
    { exact: true },
  );
  await selectThenEdit(page, bodyCopy);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited body copy");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(
    frame.getByText("Edited body copy", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(
    frame.getByText(
      "This paragraph can be edited directly in the canvas.",
      { exact: true },
    ),
  ).toBeVisible();

  for (const [slideNumber, copy] of [
    [10, "Nested text blocks stay editable through real pointer paths."],
    [13, "The selection proxy resolves the intended text target."],
  ] as const) {
    await page
      .getByRole("button", { name: `슬라이드 ${slideNumber} 선택` })
      .click();
    const target = frame.getByText(copy, { exact: true });
    await selectThenEdit(page, target);
    await page.keyboard.press("Escape");
    await expect(target).not.toHaveAttribute("contenteditable", "true");
    // Navigating inside the sandboxed frame cannot write a URL, and that
    // restriction must not reach the status bar as a deck error.
    await expect(page.getByRole("alert")).toHaveCount(0);
  }

  // The zoom wrapper CSS-scales an ancestor of the frame, so a proxy double
  // click has to divide out that scale before the frame resolves the point.
  // At 100% the scale is 1 and a wrong conversion still looks correct.
  await page.getByRole("button", { name: "슬라이드 8 선택" }).click();
  for (let step = 0; step < 5; step += 1) {
    await page.getByLabel("축소").click();
  }
  const zoomedCopy = frame.getByText(
    "This paragraph can be edited directly in the canvas.",
    { exact: true },
  );
  await selectThenEdit(page, zoomedCopy);
  // Editing the element that was double clicked, not a neighbour it overlaps.
  await expect(frame.locator('[contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  for (let step = 0; step < 5; step += 1) {
    await page.getByLabel("확대").click();
  }

  await page.getByRole("button", { name: "슬라이드 1 선택" }).click();
  const originalTitle = frame.locator("#s1 h1");
  await expect(originalTitle).toContainText("HTML Slide Editor");
  await originalTitle.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Temporary reference title");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(frame.getByText("Temporary reference title")).toBeVisible();
  await expect(page.getByRole("button", { name: "실행 취소" })).toBeEnabled();
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(originalTitle).toContainText("HTML Slide Editor");

  await reorderSlide(page, 1, 2);
  await expect
    .poll(() =>
      frame.locator("#stage > .slide").evaluateAll((slides) =>
        slides.slice(0, 2).map((slide) => slide.id),
      ),
    )
    .toEqual(["s2", "s1"]);
  await reorderSlide(page, 2, 1);
  await expect
    .poll(() =>
      frame.locator("#stage > .slide").evaluateAll((slides) =>
        slides.slice(0, 2).map((slide) => slide.id),
      ),
    )
    .toEqual(["s1", "s2"]);

  const exported = await downloadDeck(
    page,
    testInfo,
    "reference-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);
  await expect(page.locator("#stage > .slide")).toHaveCount(22);

  for (const [slide, id, name] of [
    [2, "s2", "reference-text-heavy.png"],
    [3, "s3", "reference-svg.png"],
    [8, "e2e-overview", "reference-image.png"],
    [21, "s12", "reference-steps.png"],
    [22, "s13", "reference-closing.png"],
  ] as const) {
    await activateSlide(page, slide, id);
    const active = page.locator("#stage > .slide.active");
    await expectNonBlankPixels(active, 0.05);
    if (process.platform === "darwin") {
      await expect(active).toHaveScreenshot(name, {
        animations: "disabled",
        maxDiffPixelRatio: 0.01,
      });
    }
  }

  await activateSlide(page, 21, "s12");
  const step = page.locator("#s12 [data-step]").first();
  await expect(page.locator("#s12")).toHaveClass(/active/);
  await expect(step).not.toHaveClass(/revealed/);
  await page.keyboard.press("ArrowRight");
  await expect(step).toHaveClass(/revealed/);
});
