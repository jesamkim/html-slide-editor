import { describe, expect, it, vi } from "vitest";
import {
  applyDomMutationRecord,
  deleteObject,
  deleteSlide,
  cloneWithFreshIdentifiers,
  cloneWithFreshIdentifiersAndMap,
  duplicateObject,
  duplicateSlide,
  ensurePersistentId,
  reorderSlide,
} from "./mutations";

describe("document mutations", () => {
  it("applies reversible DOM records without inventing a second mutation format", () => {
    document.body.innerHTML = `
      <section data-hse-id="parent-1">
        <div data-hse-id="first">First</div>
      </section>`;
    const record = {
      parentId: "parent-1",
      index: 1,
      html: '<div data-hse-id="copy-1">Copy</div>',
    };

    applyDomMutationRecord("copy-1", record);
    expect(document.querySelector("[data-hse-id='copy-1']")).toHaveTextContent(
      "Copy",
    );

    applyDomMutationRecord("copy-1", null);
    expect(document.querySelector("[data-hse-id='copy-1']")).toBeNull();
  });

  it("validates a DOM record before changing the current document", () => {
    document.body.innerHTML = `
      <section data-hse-id="parent-1">
        <div data-hse-id="node-1">Original</div>
      </section>`;
    const before = document.body.innerHTML;

    expect(() =>
      applyDomMutationRecord("node-1", {
        parentId: "missing-parent",
        index: 0,
        html: '<div data-hse-id="node-1">Moved</div>',
      }),
    ).toThrow("부모 요소");
    expect(document.body.innerHTML).toBe(before);
  });

  it("creates one persistent editor id and preserves it", () => {
    const element = document.createElement("div");

    const id = ensurePersistentId(element);

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(element.getAttribute("data-hse-id")).toBe(id);
    expect(ensurePersistentId(element)).toBe(id);
  });

  it("replaces a persistent id already owned by another element", () => {
    document.body.innerHTML = `
      <div data-hse-id="duplicate"></div>
      <div data-hse-id="duplicate"></div>`;
    const elements = [...document.querySelectorAll("div")];

    const id = ensurePersistentId(elements[1]);

    expect(elements[0].getAttribute("data-hse-id")).toBe("duplicate");
    expect(id).not.toBe("duplicate");
    expect(elements[1].getAttribute("data-hse-id")).toBe(id);
  });

  it("duplicates an object with unique descendant ids and rewritten internal references", () => {
    document.body.innerHTML = `
      <main id="stage">
        <section class="slide">
          <div id="card" data-hse-id="object-1" data-hse-temp-id="temp-1">
            <label id="label" data-hse-id="label-1" for="field">Name</label>
            <input id="field" aria-labelledby="label external-label">
            <a id="jump" href="#field">Jump</a>
            <svg>
              <style>.shape { clip-path: url(#clip); }</style>
              <defs><clipPath id="clip"><rect></rect></clipPath></defs>
              <rect id="shape" clip-path="url(#clip)" style="filter: url('#clip')"></rect>
              <use href="#shape" xlink:href="#shape"></use>
            </svg>
          </div>
        </section>
      </main>`;
    const source = document.querySelector<HTMLElement>("#card")!;

    const result = duplicateObject(source);
    const copy = result.element;

    expect(copy).not.toBeNull();
    expect(copy).toBe(source.nextElementSibling);
    expect(copy!.id).not.toBe("card");
    expect(copy!.getAttribute("data-hse-id")).not.toBe("object-1");
    expect(copy!.querySelector("[data-hse-temp-id]")).toBeNull();
    expect(copy!.hasAttribute("data-hse-temp-id")).toBe(false);

    const copiedLabel = copy!.querySelector<HTMLLabelElement>("label")!;
    const copiedField = copy!.querySelector<HTMLInputElement>("input")!;
    const copiedLink = copy!.querySelector<HTMLAnchorElement>("a")!;
    const copiedClip = copy!.querySelector<SVGElement>("clipPath")!;
    const copiedShape =
      copy!.querySelector<SVGElement>("rect[clip-path]")!;
    const copiedUse = copy!.querySelector<SVGUseElement>("use")!;

    expect(copiedLabel.id).not.toBe("label");
    expect(copiedLabel.getAttribute("data-hse-id")).not.toBe("label-1");
    expect(copiedLabel.htmlFor).toBe(copiedField.id);
    expect(copiedField.getAttribute("aria-labelledby")).toBe(
      `${copiedLabel.id} external-label`,
    );
    expect(copiedLink.getAttribute("href")).toBe(`#${copiedField.id}`);
    expect(copiedShape.getAttribute("clip-path")).toBe(
      `url(#${copiedClip.id})`,
    );
    expect(copiedShape.getAttribute("style")).toContain(
      `url('#${copiedClip.id}')`,
    );
    expect(copy!.querySelector("style")!.textContent).toMatch(
      new RegExp(`url\\(["']?#${copiedClip.id}["']?\\)`),
    );
    expect(copiedUse.getAttribute("href")).toBe(`#${copiedShape.id}`);
    expect(copiedUse.getAttribute("xlink:href")).toBe(`#${copiedShape.id}`);

    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map(
      (element) => element.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns the persistent id mapping for every cloned edited descendant", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div data-hse-id="card-old">
          <h2 data-hse-id="title-old">Title</h2>
          <p data-hse-id="body-old">Body</p>
        </div>
      </section>`;

    const result = cloneWithFreshIdentifiersAndMap(
      document.querySelector<HTMLElement>('[data-hse-id="card-old"]')!,
    );

    expect(result.element.getAttribute("data-hse-id")).toBe(
      result.persistentIdMap["card-old"],
    );
    expect(
      result.element.querySelector("h2")?.getAttribute("data-hse-id"),
    ).toBe(result.persistentIdMap["title-old"]);
    expect(
      result.element.querySelector("p")?.getAttribute("data-hse-id"),
    ).toBe(result.persistentIdMap["body-old"]);
    expect(Object.keys(result.persistentIdMap).sort()).toEqual([
      "body-old",
      "card-old",
      "title-old",
    ]);
  });

  it("retries cloned persistent ids that collide with the document registry", () => {
    document.body.innerHTML = `
      <section data-hse-id="parent-1">
        <div data-hse-id="00000000-0000-4000-8000-000000000001"></div>
        <div data-hse-id="source-id">
          <span data-hse-id="00000000-0000-4000-8000-000000000003"></span>
        </div>
      </section>`;
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000004");

    try {
      const copy = duplicateObject(
        document.querySelector<HTMLElement>('[data-hse-id="source-id"]')!,
      ).element!;
      const ids = [
        ...document.querySelectorAll<HTMLElement>("[data-hse-id]"),
      ].map((element) => element.dataset.hseId);

      expect(copy.dataset.hseId).toBe(
        "00000000-0000-4000-8000-000000000002",
      );
      expect(copy.querySelector("span")?.getAttribute("data-hse-id")).toBe(
        "00000000-0000-4000-8000-000000000004",
      );
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("keeps repeated SVG ids and CSS references inside each copied SVG scope", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div data-role="object">
          <svg data-scope="first">
            <style>#shape { clip-path: url(#clip); }</style>
            <defs><clipPath id="clip"><rect></rect></clipPath></defs>
            <rect id="shape" clip-path="url(#clip)"></rect>
          </svg>
          <svg data-scope="second">
            <style>#shape { clip-path: url(#clip); }</style>
            <defs><clipPath id="clip"><circle></circle></clipPath></defs>
            <rect id="shape" clip-path="url(#clip)"></rect>
          </svg>
        </div>
      </section>`;

    const copy = duplicateObject(
      document.querySelector<HTMLElement>('[data-role="object"]')!,
    ).element!;
    const copiedSvgs = [...copy.querySelectorAll<SVGSVGElement>("svg")];

    expect(copiedSvgs).toHaveLength(2);
    for (const svg of copiedSvgs) {
      const clip = svg.querySelector<SVGElement>("clipPath")!;
      const shape = svg.querySelector<SVGElement>("rect[clip-path]")!;
      const css = svg.querySelector("style")!.textContent!;

      expect(shape.getAttribute("clip-path")).toBe(`url(#${clip.id})`);
      expect(css).toContain(`#${shape.id}`);
      expect(css).toMatch(
        new RegExp(`url\\(["']?#${clip.id}["']?\\)`),
      );
    }
    expect(
      copiedSvgs[0].querySelector("clipPath")!.id,
    ).not.toBe(copiedSvgs[1].querySelector("clipPath")!.id);
    expect(
      copiedSvgs[0].querySelector("rect[clip-path]")!.id,
    ).not.toBe(copiedSvgs[1].querySelector("rect[clip-path]")!.id);
  });

  it("rewrites supported IDREF attributes while preserving external tokens", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div data-role="object">
          <label id="label" data-role="label" for="field">Field</label>
          <form id="form" data-role="form"></form>
          <datalist id="choices" data-role="choices"></datalist>
          <div id="panel" data-role="panel"></div>
          <div id="option" data-role="option"></div>
          <div id="details" data-role="details"></div>
          <div id="error" data-role="error"></div>
          <div id="heading" data-role="heading"></div>
          <div id="description" data-role="description"></div>
          <input id="field" data-role="field"
            aria-controls="panel external-controls"
            aria-owns="panel external-owner"
            aria-activedescendant="option"
            aria-details="details"
            aria-errormessage="error"
            aria-labelledby="label external-label"
            aria-describedby="description external-description"
            headers="heading external-heading"
            list="choices"
            form="form">
        </div>
      </section>`;

    const copy = duplicateObject(
      document.querySelector<HTMLElement>('[data-role="object"]')!,
    ).element!;
    const byRole = (role: string) =>
      copy.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    const field = byRole("field");

    expect(byRole("label").getAttribute("for")).toBe(field.id);
    expect(field.getAttribute("aria-controls")).toBe(
      `${byRole("panel").id} external-controls`,
    );
    expect(field.getAttribute("aria-owns")).toBe(
      `${byRole("panel").id} external-owner`,
    );
    expect(field.getAttribute("aria-activedescendant")).toBe(
      byRole("option").id,
    );
    expect(field.getAttribute("aria-details")).toBe(byRole("details").id);
    expect(field.getAttribute("aria-errormessage")).toBe(byRole("error").id);
    expect(field.getAttribute("aria-labelledby")).toBe(
      `${byRole("label").id} external-label`,
    );
    expect(field.getAttribute("aria-describedby")).toBe(
      `${byRole("description").id} external-description`,
    );
    expect(field.getAttribute("headers")).toBe(
      `${byRole("heading").id} external-heading`,
    );
    expect(field.getAttribute("list")).toBe(byRole("choices").id);
    expect(field.getAttribute("form")).toBe(byRole("form").id);
  });

  it("runs the pure clone helper after source serialization", () => {
    document.body.innerHTML = `
      <div id="card"><label id="label" for="field">Name</label><input id="field"></div>`;
    const loadSerializedHelper = new Function(
      `return (${cloneWithFreshIdentifiers.toString()});`,
    ) as () => typeof cloneWithFreshIdentifiers;
    const serializedClone = loadSerializedHelper();

    const copy = serializedClone(document.querySelector("#card")!);

    expect(copy.id).not.toBe("card");
    expect(copy.querySelector("label")!.htmlFor).toBe(
      copy.querySelector("input")!.id,
    );
  });

  it("returns an insertion record that can compensate an object duplicate", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div id="first"></div>
        <div id="card">Card</div>
      </section>`;
    const source = document.querySelector<HTMLElement>("#card")!;

    const result = duplicateObject(source);
    const parent = source.parentElement!;

    expect(result.before).toBeNull();
    expect(result.after).toEqual({
      parentId: parent.getAttribute("data-hse-id"),
      index: 2,
      html: result.element!.outerHTML,
    });
  });

  it("deletes an object only after recording its exact prior location", () => {
    document.body.innerHTML = `
      <section class="slide">
        <div id="first"></div>
        <div id="card"><span>Card</span></div>
      </section>`;
    const target = document.querySelector<HTMLElement>("#card")!;
    const originalHtml = target.outerHTML;
    const parent = target.parentElement!;

    const result = deleteObject(target);

    expect(target.isConnected).toBe(false);
    expect(result.element).toBeNull();
    expect(result.before).toEqual({
      parentId: parent.getAttribute("data-hse-id"),
      index: 1,
      html: originalHtml,
    });
    expect(result.after).toBeNull();
  });

  it("duplicates a slide after the source with a reversible insertion record", () => {
    document.body.innerHTML = `
      <div id="stage">
        <section class="slide" id="slide-a"><h2 id="title-a">A</h2></section>
        <section class="slide" id="slide-b">B</section>
      </div>`;
    const source = document.querySelector<HTMLElement>("#slide-a")!;

    const result = duplicateSlide(source);
    const slides = [...document.querySelectorAll<HTMLElement>(".slide")];

    expect(slides).toHaveLength(3);
    expect(result.element).toBe(slides[1]);
    expect(result.element!.id).not.toBe("slide-a");
    expect(result.element!.querySelector("h2")!.id).not.toBe("title-a");
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({
      parentId: source.parentElement!.getAttribute("data-hse-id"),
      index: 1,
      html: result.element!.outerHTML,
    });
  });

  it("does not delete the final slide or mutate the rejected document", () => {
    document.body.innerHTML = `
      <div id="stage"><section class="slide"></section></div>`;
    const stage = document.querySelector<HTMLElement>("#stage")!;
    const before = document.body.innerHTML;

    expect(() => deleteSlide(document.querySelector(".slide")!)).toThrow(
      "마지막 슬라이드는 삭제할 수 없습니다.",
    );
    expect(document.body.innerHTML).toBe(before);
    expect(stage.hasAttribute("data-hse-id")).toBe(false);
  });

  it("deletes a slide when another slide remains and records its prior state", () => {
    document.body.innerHTML = `
      <div id="stage">
        <section class="slide" id="slide-a">A</section>
        <section class="slide" id="slide-b">B</section>
      </div>`;
    const target = document.querySelector<HTMLElement>("#slide-b")!;
    const originalHtml = target.outerHTML;

    const result = deleteSlide(target);

    expect(document.querySelectorAll(".slide")).toHaveLength(1);
    expect(result.before).toEqual({
      parentId: document
        .querySelector("#stage")!
        .getAttribute("data-hse-id"),
      index: 1,
      html: originalHtml,
    });
    expect(result.after).toBeNull();
  });

  it("reorders slides and returns exact before and after records", () => {
    document.body.innerHTML = `
      <div id="stage">
        <section class="slide" id="slide-a">A</section>
        <section class="slide" id="slide-b">B</section>
        <section class="slide" id="slide-c">C</section>
      </div>`;
    const target = document.querySelector<HTMLElement>("#slide-a")!;
    const originalHtml = target.outerHTML;

    const result = reorderSlide(target, 2);

    expect(
      [...document.querySelectorAll<HTMLElement>(".slide")].map(
        (slide) => slide.textContent,
      ),
    ).toEqual(["B", "C", "A"]);
    expect(result.element).toBe(target);
    expect(result.before).toEqual({
      parentId: target.parentElement!.getAttribute("data-hse-id"),
      index: 0,
      html: originalHtml,
    });
    expect(result.after).toEqual({
      parentId: target.parentElement!.getAttribute("data-hse-id"),
      index: 2,
      html: originalHtml,
    });
  });

  it("records actual parent child positions when non-slide children are mixed in", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div id="chrome-before"></div>
        <section class="slide" id="slide-a">A</section>
        <aside id="chrome-middle"></aside>
        <section class="slide" id="slide-b">B</section>
        <footer id="chrome-after"></footer>
      </div>`;
    const target = document.querySelector<HTMLElement>("#slide-a")!;

    const result = reorderSlide(target, 1);

    expect([...target.parentElement!.children].map((child) => child.id)).toEqual([
      "chrome-before",
      "chrome-middle",
      "slide-b",
      "slide-a",
      "chrome-after",
    ]);
    expect(result.before?.index).toBe(1);
    expect(result.after?.index).toBe(3);
  });

  it.each([-1, 3, 1.5])(
    "rejects invalid slide reorder index %s before changing the document",
    (index) => {
      document.body.innerHTML = `
        <div id="stage">
          <section class="slide" id="slide-a">A</section>
          <section class="slide" id="slide-b">B</section>
          <section class="slide" id="slide-c">C</section>
        </div>`;
      const stage = document.querySelector<HTMLElement>("#stage")!;
      const before = document.body.innerHTML;

      expect(() =>
        reorderSlide(document.querySelector("#slide-a")!, index),
      ).toThrow("슬라이드 순서 범위를 벗어났습니다.");
      expect(document.body.innerHTML).toBe(before);
      expect(stage.hasAttribute("data-hse-id")).toBe(false);
    },
  );
});
