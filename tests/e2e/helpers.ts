import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { PNG } from "pngjs";
import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const minimalDeckPath = fileURLToPath(
  new URL("../fixtures/minimal-deck.html", import.meta.url),
);
export const referenceDeckPath = fileURLToPath(
  new URL("../fixtures/reference-deck.html", import.meta.url),
);

export const editorFrame = (page: Page) =>
  page.getByTitle("편집 중인 슬라이드").contentFrame();

export const slideItems = (page: Page) =>
  page.getByLabel("슬라이드 목록").locator("[data-slide-id]");

export async function importDeck(
  page: Page,
  filePath: string,
  expectedSlides: number,
) {
  await page.goto("/");
  await page.getByLabel("HTML 파일 선택").setInputFiles(filePath);
  await expect(slideItems(page)).toHaveCount(expectedSlides);
  await expect(page.getByRole("button", { name: "HTML 내보내기" })).toBeEnabled();
  await expect(editorFrame(page).locator(".slide.active")).toHaveCount(1);
}

export async function waitForRecoverySaved(
  page: Page,
  expectedFirstSlideId?: string,
) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (firstSlideId) =>
            new Promise<number>((resolve, reject) => {
              const request = indexedDB.open("html-slide-editor");
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction("sessions", "readonly");
                const recordsRequest = transaction.objectStore("sessions").getAll();
                recordsRequest.onerror = () => reject(recordsRequest.error);
                recordsRequest.onsuccess = () => {
                  const records = recordsRequest.result as Array<{
                    html?: string;
                    updatedAt?: number;
                  }>;
                  const latest = records.sort(
                    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
                  )[0];
                  const first = latest?.html
                    ? new DOMParser()
                        .parseFromString(latest.html, "text/html")
                        .querySelector("#stage > .slide")?.id
                    : null;
                  resolve(
                    !firstSlideId || first === firstSlideId
                      ? records.length
                      : 0,
                  );
                  database.close();
                };
              };
            }),
          expectedFirstSlideId,
        ),
      { message: "recovery record to be persisted", timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

export async function downloadDeck(
  page: Page,
  testInfo: TestInfo,
  expectedName: string,
) {
  const filePath = testInfo.outputPath(expectedName);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "HTML 내보내기" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(expectedName);
  await download.saveAs(filePath);
  return filePath;
}

export async function removeArtifact(filePath: string) {
  await rm(filePath, { force: true });
}

export async function openDownloadedDeck(page: Page, filePath: string) {
  await page.goto(pathToFileURL(filePath).href);
  await expect(page.locator("#stage > .slide")).not.toHaveCount(0);
  await expect(page.locator("#stage > .slide.active")).toHaveCount(1);
}

export async function expectActiveSlide(
  page: Page,
  slideNumber: number,
  expectedId?: string,
) {
  await expect(page).toHaveURL(new RegExp(`#${slideNumber}$`));
  const active = page.locator("#stage > .slide.active");
  await expect(active).toHaveCount(1);
  if (expectedId) await expect(active).toHaveAttribute("id", expectedId);
}

export async function activateSlide(
  page: Page,
  slideNumber: number,
  expectedId?: string,
) {
  await page.evaluate((number) => {
    location.hash = String(number);
  }, slideNumber);
  await expectActiveSlide(page, slideNumber, expectedId);
}

export async function expectNonBlankPixels(
  locator: Locator,
  minimumColoredRatio = 0.01,
) {
  const png = PNG.sync.read(await locator.screenshot());
  let colored = 0;
  const colors = new Set<number>();

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const alpha = png.data[index + 3];
    if (alpha === 0) continue;
    if (red < 245 || green < 245 || blue < 245) colored += 1;
    if (index % 64 === 0) {
      colors.add((red << 16) | (green << 8) | blue);
    }
  }

  const pixels = png.width * png.height;
  expect(colored / pixels).toBeGreaterThan(minimumColoredRatio);
  expect(colors.size).toBeGreaterThan(8);
}

const centreOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
};

/**
 * Selects the element that contains `target`, then double clicks the target to
 * start editing it.
 *
 * The two steps measure separately on purpose. Selecting can reveal a build
 * step, which re-lays out the slide and moves the target by a dozen pixels, so
 * a coordinate taken before the click no longer lands on it. A person sees the
 * moved text and clicks where it now is, and the test has to do the same.
 */
export async function selectThenEdit(page: Page, target: Locator) {
  await page.mouse.move(0, 0);
  const first = await centreOf(target);
  await page.mouse.click(first.x, first.y);
  const proxy = page.getByTestId("selection-proxy");
  await expect(proxy).toBeVisible();
  const settled = await centreOf(target);
  await page.mouse.dblclick(settled.x, settled.y);
  await expect(target).toHaveAttribute("contenteditable", "true");
}

export async function dragBy(
  page: Page,
  locator: Locator,
  deltaX: number,
  deltaY: number,
) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 8 });
  await page.mouse.up();
}

export async function reorderSlide(
  page: Page,
  fromSlide: number,
  toSlide: number,
) {
  const handle = page.getByRole("button", {
    name: `슬라이드 ${fromSlide} 이동`,
  });
  const target = slideItems(page).nth(toSlide - 1);
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  const startX = handleBox!.x + handleBox!.width / 2;
  const startY = handleBox!.y + handleBox!.height / 2;
  const endX = targetBox!.x + targetBox!.width / 2;
  const endY = targetBox!.y + targetBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + Math.sign(endY - startY) * 8, {
    steps: 2,
  });
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();
}
