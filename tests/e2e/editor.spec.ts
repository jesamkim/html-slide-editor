import { expect, test } from "@playwright/test";
import {
  downloadDeck,
  dragBy,
  editorFrame,
  importDeck,
  minimalDeckPath,
  reorderSlide,
  removeArtifact,
  slideItems,
  waitForRecoverySaved,
} from "./helpers";

test("supports reverse sibling selection, keyboard movement, blur commit, and breadcrumbs", async ({
  page,
}) => {
  await importDeck(page, minimalDeckPath, 2);
  const frame = editorFrame(page);
  const subtitle = frame.getByText("Editable subtitle", { exact: true });
  await subtitle.click();
  await expect(page.getByRole("navigation", { name: "선택 경로" })).toContainText(
    "p#editable-subtitle.subtitle",
  );

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("텍스트 내용")).toHaveValue("First title");
  const title = frame.getByText("First title", { exact: true });
  await title.press("ArrowRight");
  await expect(title).toHaveCSS("translate", "1px");
  await title.press("Shift+ArrowDown");
  await expect(title).toHaveCSS("translate", "1px 10px");

  await title.press("Enter");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Blur committed title");
  await page.getByRole("tab", { name: "배치" }).click();
  await expect(
    frame.getByText("Blur committed title", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "실행 취소" })).toBeEnabled();
});

test("edits, transforms, mutates, recovers, and exports through the public UI", async ({
  page,
}, testInfo) => {
  await importDeck(page, minimalDeckPath, 2);

  const canvas = page.getByLabel("슬라이드 캔버스");
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await expect(page.getByLabel("편집기 상태")).toContainText("160%");
  await canvas.evaluate((element) => {
    element.scrollTo({ left: element.scrollWidth, top: element.scrollHeight });
  });
  await expect
    .poll(() =>
      canvas.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    )
    .toMatchObject({
      left: expect.any(Number),
      top: expect.any(Number),
    });
  expect(await canvas.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const frame = editorFrame(page);
  const title = frame.getByText("First title", { exact: true });
  await title.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited title");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(frame.getByText("Edited title", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "실행 취소" })).toBeEnabled();

  await frame.getByText("Edited title", { exact: true }).click();
  await expect(page.getByLabel("텍스트 내용")).toHaveValue("Edited title");
  await page.getByLabel("글자 크기").fill("48");
  await page.getByLabel("글자 색상").fill("#b42318");
  await page.getByRole("button", { name: "굵게" }).click();
  await page.getByRole("button", { name: "가운데 정렬" }).click();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(frame.getByText("Edited title", { exact: true })).toHaveCSS(
    "color",
    "rgb(180, 35, 24)",
  );
  await expect(frame.getByText("Edited title", { exact: true })).toHaveCSS(
    "font-size",
    "48px",
  );

  const selection = page.getByTestId("selection-proxy");
  const beforeMove = await selection.boundingBox();
  const beforeTitleMove = await frame
    .getByText("Edited title", { exact: true })
    .boundingBox();
  await dragBy(page, selection, 42, 28);
  await expect
    .poll(async () => (await selection.boundingBox())?.x)
    .toBeGreaterThan(beforeMove!.x + 20);
  await expect
    .poll(
      async () =>
        (await frame.getByText("Edited title", { exact: true }).boundingBox())
          ?.x,
    )
    .toBeGreaterThan(beforeTitleMove!.x + 20);

  const beforeResize = await selection.boundingBox();
  await page.getByRole("tab", { name: "배치" }).click();
  const widthInput = page.getByLabel("너비");
  const logicalWidth = Number(await widthInput.inputValue());
  await widthInput.fill(String(logicalWidth + 80));
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect
    .poll(async () => (await selection.boundingBox())?.width)
    .toBeGreaterThan(beforeResize!.width + 30);

  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect
    .poll(async () => (await selection.boundingBox())?.width)
    .toBeCloseTo(beforeResize!.width, 0);
  await page.getByRole("button", { name: "다시 실행" }).click();
  await expect
    .poll(async () => (await selection.boundingBox())?.width)
    .toBeGreaterThan(beforeResize!.width + 30);

  await frame.getByText("Editable subtitle", { exact: true }).click();
  await page.getByRole("button", { name: "선택 항목 복제" }).first().click();
  await expect(frame.getByText("Editable subtitle", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "선택 항목 삭제" }).first().click();
  await expect(frame.getByText("Editable subtitle", { exact: true })).toHaveCount(1);

  await page.getByRole("button", { name: "슬라이드 2 복제" }).click();
  await expect(slideItems(page)).toHaveCount(3);
  await page.getByRole("button", { name: "슬라이드 3 삭제" }).click();
  await expect(slideItems(page)).toHaveCount(2);

  await page.getByRole("button", { name: "슬라이드 1 선택" }).click();
  await expect(frame.locator(".slide.active")).toContainText("Edited title");
  await reorderSlide(page, 1, 2);
  await expect
    .poll(() =>
      frame.locator("#stage > .slide").evaluateAll((slides) =>
        slides.map((slide) => slide.id),
      ),
    )
    .toEqual(["second-slide", "first-slide"]);
  await page.getByRole("button", { name: "슬라이드 2 선택" }).click();
  await expect(frame.locator(".slide.active")).toContainText("Edited title");
  await reorderSlide(page, 2, 1);
  await expect
    .poll(() =>
      frame.locator("#stage > .slide").evaluateAll((slides) =>
        slides.map((slide) => slide.id),
      ),
    )
    .toEqual(["first-slide", "second-slide"]);
  await page.getByRole("button", { name: "슬라이드 1 선택" }).click();
  await expect(frame.locator(".slide.active")).toContainText("Edited title");

  const exported = await downloadDeck(
    page,
    testInfo,
    "minimal-deck-edited.html",
  );
  await removeArtifact(exported);

  await waitForRecoverySaved(page);
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "세션 복구", exact: true }).click();
  await expect(editorFrame(page).locator(".slide.active")).toContainText(
    "Edited title",
  );
  await expect(slideItems(page)).toHaveCount(2);
});
