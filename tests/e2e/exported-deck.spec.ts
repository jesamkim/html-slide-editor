import { expect, test } from "@playwright/test";
import {
  activateSlide,
  downloadDeck,
  editorFrame,
  expectActiveSlide,
  expectNonBlankPixels,
  importDeck,
  minimalDeckPath,
  openDownloadedDeck,
  reorderSlide,
  slideItems,
  waitForRecoverySaved,
} from "./helpers";

test("exports an independent deck with edits and original engine behavior", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);
  const frame = editorFrame(page);
  await frame.getByText("First title", { exact: true }).dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Exported title");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("button", { name: "실행 취소" })).toBeEnabled();
  await frame.getByText("Exported title", { exact: true }).click();
  await page.getByLabel("글자 크기").fill("46");
  await page.getByLabel("글자 색상").fill("#b42318");
  await expect(page.getByLabel("글자 크기")).toHaveValue("46");
  await expect(page.getByLabel("글자 색상")).toHaveValue("#b42318");
  await page.getByRole("button", { name: "적용", exact: true }).click();

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);
  await expect(page.locator("#stage > .slide")).toHaveCount(2);
  await expect(page.getByText("Exported title", { exact: true })).toHaveCSS(
    "font-size",
    "46px",
  );
  await expect(page.getByText("Exported title", { exact: true })).toHaveCSS(
    "color",
    "rgb(180, 35, 24)",
  );
  await expect(
    page.locator(
      "[data-hse-editor-bridge], [data-hse-editor-artifact], [data-hse-temp-id]",
    ),
  ).toHaveCount(0);
  const entryAnimation = await page.locator("#first-slide").evaluate((slide) => {
    const animated = slide.querySelector<HTMLElement>(".animate-in")!;
    slide.classList.remove("entered");
    void animated.offsetWidth;
    slide.classList.add("entered");
    const animation = animated.getAnimations()[0];
    return animation
      ? {
          playState: animation.playState,
          duration: animation.effect?.getTiming().duration,
        }
      : null;
  });
  expect(entryAnimation).toEqual({
    playState: "running",
    duration: 300,
  });

  await page.keyboard.press("ArrowRight");
  await expectActiveSlide(page, 2, "second-slide");
  const steps = page.locator("#second-slide [data-step]");
  await expect(steps.nth(0)).not.toHaveClass(/revealed/);
  await page.keyboard.press("ArrowRight");
  await expect(steps.nth(0)).toHaveClass(/revealed/);
  await expect(steps.nth(1)).not.toHaveClass(/revealed/);
  await page.keyboard.press("ArrowRight");
  await expect(steps.nth(1)).toHaveClass(/revealed/);
  await page.keyboard.press("ArrowLeft");
  await expect(steps.nth(1)).not.toHaveClass(/revealed/);
  await page.keyboard.press("ArrowLeft");
  await expect(steps.nth(0)).not.toHaveClass(/revealed/);
  await page.keyboard.press("ArrowLeft");
  await expectActiveSlide(page, 1, "first-slide");
  await page.keyboard.press("Home");
  await expectActiveSlide(page, 1, "first-slide");
  await page.keyboard.press("End");
  await expectActiveSlide(page, 2, "second-slide");
  await expect(steps).toHaveClass([/revealed/, /revealed/]);
  await page.keyboard.press("Home");
  await page.locator("#first-slide").click({ position: { x: 900, y: 500 } });
  await expectActiveSlide(page, 2, "second-slide");
  await activateSlide(page, 2, "second-slide");
  await expectNonBlankPixels(page.locator("#chart"), 0.2);
});

test("exports immediately after restoring a reveal-first reordered deck", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);
  await reorderSlide(page, 2, 1);
  await expect
    .poll(() =>
      editorFrame(page).locator("#stage > .slide").evaluateAll((slides) =>
        slides.map((slide) => slide.id),
      ),
    )
    .toEqual(["second-slide", "first-slide"]);
  await waitForRecoverySaved(page, "second-slide");
  await page.reload();
  await page.getByRole("button", { name: "세션 복구", exact: true }).click();

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);
  expect(
    await page.locator("#stage > .slide").evaluateAll((slides) =>
      slides.map((slide) => slide.id),
    ),
  ).toEqual(["second-slide", "first-slide"]);
});

test("retains duplicated object and slide identities after export and reopen", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);
  const frame = editorFrame(page);

  await frame.getByText("Editable subtitle", { exact: true }).click();
  await page
    .getByRole("button", { name: "선택 항목 복제" })
    .first()
    .click();
  const subtitles = frame.locator("#first-slide .subtitle");
  await expect(subtitles).toHaveCount(2);
  const expectedObjectIds = await subtitles.evaluateAll((elements) =>
    elements.map((element) => element.id),
  );
  expect(expectedObjectIds[0]).toBe("editable-subtitle");
  expect(expectedObjectIds[1]).toMatch(/^hse-/);
  expect(new Set(expectedObjectIds).size).toBe(2);

  await page.getByRole("button", { name: "슬라이드 2 복제" }).click();
  await expect(slideItems(page)).toHaveCount(3);
  const expectedSlides = await frame
    .locator("#stage > .slide")
    .evaluateAll((slides) =>
      slides.map((slide) => ({
        id: slide.id,
        title: slide.querySelector("h1,h2")?.textContent,
      })),
    );
  expect(expectedSlides.slice(0, 2)).toEqual([
    { id: "first-slide", title: "First title" },
    { id: "second-slide", title: "Second slide" },
  ]);
  expect(expectedSlides[2]).toMatchObject({ title: "Second slide" });
  expect(expectedSlides[2].id).toMatch(/^hse-/);
  expect(new Set(expectedSlides.map((slide) => slide.id)).size).toBe(3);

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);

  await expect(page.locator("#stage > .slide")).toHaveCount(3);
  await expect(
    page.getByText("Editable subtitle", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByText("Second slide", { exact: true })).toHaveCount(2);
  expect(
    await page.locator("#first-slide .subtitle").evaluateAll((elements) =>
      elements.map((element) => element.id),
    ),
  ).toEqual(expectedObjectIds);
  expect(
    await page.locator("#stage > .slide").evaluateAll((slides) =>
      slides.map((slide) => ({
        id: slide.id,
        title: slide.querySelector("h1,h2")?.textContent,
      })),
    ),
  ).toEqual(expectedSlides);
});

test("duplicates edited overrides through undo, redo, export, and reopen", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);
  const frame = editorFrame(page);

  const subtitle = frame.getByText("Editable subtitle", { exact: true });
  await subtitle.click();
  await page.getByLabel("글자 크기").fill("32");
  await page.getByLabel("글자 색상").fill("#b42318");
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await page.getByRole("tab", { name: "배치" }).click();
  const x = Number(await page.getByLabel("X 위치").inputValue());
  await page.getByLabel("X 위치").fill(String(x + 40));
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await page
    .getByRole("button", { name: "선택 항목 복제" })
    .first()
    .click();
  await expect(frame.locator("#first-slide .subtitle")).toHaveCount(2);
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(frame.locator("#first-slide .subtitle")).toHaveCount(1);
  await page.getByRole("button", { name: "다시 실행" }).click();
  await expect(frame.locator("#first-slide .subtitle")).toHaveCount(2);

  await page.getByRole("button", { name: "슬라이드 1 복제" }).click();
  await expect(slideItems(page)).toHaveCount(3);
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(slideItems(page)).toHaveCount(2);
  await page.getByRole("button", { name: "다시 실행" }).click();
  await expect(slideItems(page)).toHaveCount(3);

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);
  const copies = page.locator(".subtitle");
  await expect(copies).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(copies.nth(index)).toHaveCSS("font-size", "32px");
    await expect(copies.nth(index)).toHaveCSS(
      "color",
      "rgb(180, 35, 24)",
    );
    await expect(copies.nth(index)).toHaveCSS("translate", "40px");
  }
});

test("retains deleted object and slide absence after export and reopen", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);
  const frame = editorFrame(page);

  await page.getByRole("button", { name: "슬라이드 2 선택" }).click();
  await frame.getByText("Second slide", { exact: true }).click();
  await page
    .getByRole("button", { name: "선택 항목 삭제" })
    .first()
    .click();
  await expect(frame.locator("#second-title")).toHaveCount(0);
  await expect(frame.getByText("Second slide", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "슬라이드 1 삭제" }).click();
  await expect(slideItems(page)).toHaveCount(1);
  expect(
    await frame.locator("#stage > .slide").evaluateAll((slides) =>
      slides.map((slide) => slide.id),
    ),
  ).toEqual(["second-slide"]);

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await openDownloadedDeck(page, exported);

  await expect(page.locator("#stage > .slide")).toHaveCount(1);
  expect(
    await page.locator("#stage > .slide").evaluateAll((slides) =>
      slides.map((slide) => slide.id),
    ),
  ).toEqual(["second-slide"]);
  await expect(page.locator("#first-slide")).toHaveCount(0);
  await expect(page.locator("#second-title")).toHaveCount(0);
  await expect(page.locator("#chart")).toHaveCount(1);
  await expect(page.getByText("First title", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Second slide", { exact: true })).toHaveCount(0);
  await expect(page.getByText("First reveal", { exact: true })).toHaveCount(1);
});
