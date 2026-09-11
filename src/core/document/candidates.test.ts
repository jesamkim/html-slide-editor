import { describe, expect, it } from "vitest";
import {
  isEditableCandidate,
  scoreEditableCandidate,
  selectCandidate,
} from "./candidates";

const rect = (width: number, height: number): DOMRect =>
  new DOMRect(0, 0, width, height);

const setRect = (element: Element, width: number, height: number) => {
  element.getBoundingClientRect = () => rect(width, height);
};

describe("editable candidates", () => {
  it("accepts visible text, image, card, and SVG elements", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div class="card"><h2>Title</h2><img src="data:," alt=""></div>
        <svg><rect width="20" height="20"></rect></svg>
      </section>`;

    expect(isEditableCandidate(document.querySelector("h2")!)).toBe(true);
    expect(isEditableCandidate(document.querySelector("img")!)).toBe(true);
    expect(isEditableCandidate(document.querySelector(".card")!)).toBe(true);
    expect(isEditableCandidate(document.querySelector("svg")!)).toBe(true);
  });

  it("rejects scripts, styles, links, metadata, and editor artifacts", () => {
    document.body.innerHTML = `
      <script></script><style></style>
      <div data-hse-editor-artifact><span>Handle</span></div>`;

    const rejected = [
      document.querySelector("script")!,
      document.querySelector("style")!,
      document.createElement("link"),
      document.createElement("meta"),
      document.querySelector("[data-hse-editor-artifact]")!,
      document.querySelector("[data-hse-editor-artifact] span")!,
    ];

    for (const element of rejected) {
      expect(isEditableCandidate(element)).toBe(false);
    }
  });

  it("rejects hidden elements and descendants of hidden elements", () => {
    document.body.innerHTML = `
      <p hidden>Direct hidden attribute</p>
      <p style="display: none">Direct hidden display</p>
      <div hidden><p>Hidden by attribute</p></div>
      <div style="display: none"><p>Hidden by display</p></div>
      <p style="visibility: hidden">Hidden visibility</p>
      <p style="visibility: collapse">Collapsed visibility</p>`;

    for (const element of document.querySelectorAll("p")) {
      expect(isEditableCandidate(element)).toBe(false);
    }
  });

  it("accepts a visible child that overrides inherited hidden visibility", () => {
    document.body.innerHTML = `
      <div style="visibility: hidden">
        <p style="visibility: visible">Visible override</p>
      </div>`;

    expect(isEditableCandidate(document.querySelector("p")!)).toBe(true);
  });

  it("uses the exact semantic, class, and capped-area score signals", () => {
    document.body.innerHTML = `<p class="card">Scored block</p>`;
    const element = document.querySelector("p")!;

    expect(scoreEditableCandidate(element, rect(1_000, 1_000))).toBe(95);
  });

  it("rejects candidates with bounds below eight pixels", () => {
    document.body.innerHTML = `<div><span>Small wrapper</span></div>`;
    const element = document.querySelector("div")!;

    expect(scoreEditableCandidate(element, rect(7, 20))).toBe(-Infinity);
    expect(scoreEditableCandidate(element, rect(20, 7))).toBe(-Infinity);
    expect(scoreEditableCandidate(element, rect(8, 8))).toBeCloseTo(0.0064);
  });

  it("ranks duplicate wrappers below semantic and layout candidates", () => {
    document.body.innerHTML = `
      <div class="semantic-wrapper"><h2>Semantic</h2></div>
      <div class="plain-wrapper"><div class="layout">Layout</div></div>`;
    const semanticWrapper = document.querySelector(".semantic-wrapper")!;
    const layoutWrapper = document.querySelector(".plain-wrapper")!;
    const semantic = document.querySelector("h2")!;
    const layout = document.querySelector(".layout")!;
    const duplicateBounds = rect(600, 400);

    expect(
      scoreEditableCandidate(semanticWrapper, duplicateBounds),
    ).toBeLessThan(scoreEditableCandidate(semantic, duplicateBounds));
    expect(scoreEditableCandidate(layoutWrapper, duplicateBounds)).toBeLessThan(
      scoreEditableCandidate(layout, duplicateBounds),
    );
  });

  it("selects the best visual block first and descends without wrapper noise", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div class="card">
          <div class="wrapper"><h2><span>Title</span></h2></div>
        </div>
      </section>`;
    const span = document.querySelector("span")!;
    const heading = document.querySelector("h2")!;
    const wrapper = document.querySelector(".wrapper")!;
    const card = document.querySelector(".card")!;
    const slide = document.querySelector(".slide")!;
    const path = [span, heading, wrapper, card, slide];

    setRect(span, 120, 30);
    setRect(heading, 600, 80);
    setRect(wrapper, 600, 80);
    setRect(card, 800, 500);
    setRect(slide, 1_200, 700);

    expect(selectCandidate(path, 0)).toBe(card);
    expect(selectCandidate(path, 1)).toBe(heading);
    expect(selectCandidate(path, 2)).toBe(span);
    expect(selectCandidate(path, 99)).toBe(span);
  });

  it("limits a full composed path to candidates inside the active slide", () => {
    document.body.innerHTML = `
      <main id="stage">
        <section class="slide">
          <div class="visual"><span>Title</span></div>
        </section>
      </main>`;
    const target = document.querySelector("span")!;
    const visual = document.querySelector(".visual")!;
    const slide = document.querySelector(".slide")!;
    const stage = document.querySelector("#stage")!;
    const path = [
      target,
      visual,
      slide,
      stage,
      document.body,
      document.documentElement,
    ];

    setRect(target, 120, 30);
    setRect(visual, 400, 200);
    setRect(slide, 1_200, 700);
    setRect(stage, 1_920, 1_080);
    setRect(document.body, 1_920, 1_080);
    setRect(document.documentElement, 1_920, 1_080);

    expect(selectCandidate(path, 0)).toBe(visual);
  });

  it("excludes document and stage chrome when a unit path has no slide boundary", () => {
    document.body.innerHTML = `
      <main id="stage"><div class="visual"><span>Title</span></div></main>`;
    const target = document.querySelector("span")!;
    const visual = document.querySelector(".visual")!;
    const stage = document.querySelector("#stage")!;
    const path = [
      target,
      visual,
      stage,
      document.body,
      document.documentElement,
    ];

    setRect(target, 120, 30);
    setRect(visual, 400, 200);
    setRect(stage, 1_920, 1_080);
    setRect(document.body, 1_920, 1_080);
    setRect(document.documentElement, 1_920, 1_080);

    expect(selectCandidate(path, 0)).toBe(visual);
  });

  it("returns null when the path has no visible editable candidate", () => {
    document.body.innerHTML = `<script></script><div hidden>Hidden</div>`;
    const path = [
      document.querySelector("script")!,
      document.querySelector("div")!,
    ];

    expect(selectCandidate(path, 0)).toBeNull();
  });

  it("runs after source serialization without module-scope state", () => {
    document.body.innerHTML = `<div class="card"><h2>Title</h2></div>`;
    const heading = document.querySelector("h2")!;
    const card = document.querySelector(".card")!;
    setRect(heading, 300, 60);
    setRect(card, 600, 400);

    const loadSerializedHelpers = new Function(`
      ${isEditableCandidate.toString()}
      ${scoreEditableCandidate.toString()}
      ${selectCandidate.toString()}
      return { isEditableCandidate, scoreEditableCandidate, selectCandidate };
    `) as () => {
      isEditableCandidate: typeof isEditableCandidate;
      scoreEditableCandidate: typeof scoreEditableCandidate;
      selectCandidate: typeof selectCandidate;
    };
    const serialized = loadSerializedHelpers();

    expect(serialized.isEditableCandidate(heading)).toBe(true);
    expect(serialized.scoreEditableCandidate(heading, rect(300, 60))).toBe(41.8);
    expect(serialized.selectCandidate([heading, card], 0)).toBe(card);
  });
});
