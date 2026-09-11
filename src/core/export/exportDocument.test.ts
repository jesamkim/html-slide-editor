import { describe, expect, it } from "vitest";
import {
  buildOverrideCss,
  cleanupEditorState,
  countHtmlIds,
  prepareExport,
  validateExport,
} from "./exportDocument";

const parse = (source: string) =>
  new DOMParser().parseFromString(source, "text/html");

describe("export cleanup", () => {
  it("uses the shared cleanup helper for the complete editor artifact manifest", () => {
    const document = parse(`
      <!doctype html><html><head>
        <style id="hse-live-overrides"></style>
        <script data-hse-editor-bridge></script>
      </head><body>
        <section class="slide active entered" data-hse-selection-anchor="x">
          <p data-step class="revealed" contenteditable="true"
             data-hse-temp-id="temp">Text</p>
        </section>
      </body></html>`);

    cleanupEditorState(document);

    expect(document.querySelector("[data-hse-editor-bridge]")).toBeNull();
    expect(document.querySelector("#hse-live-overrides")).toBeNull();
    expect(document.querySelector("[contenteditable]")).toBeNull();
    expect(document.querySelector("[data-hse-temp-id]")).toBeNull();
    expect(document.querySelector("[data-hse-selection-anchor]")).toBeNull();
    expect(document.querySelector(".slide.active")).toBeNull();
    expect(document.querySelector(".slide.entered")).toBeNull();
    expect(document.querySelector("[data-step].revealed")).toBeNull();
  });
  it("counts imported HTML ids for baseline-aware validation", () => {
    const document = parse(`
      <!doctype html><html><body>
        <svg><clipPath id="clip"></clipPath><rect id="shape"></rect></svg>
        <svg><clipPath id="clip"></clipPath><rect id="shape"></rect></svg>
        <div id="unique"></div>
      </body></html>`);

    expect(countHtmlIds(document)).toEqual({
      clip: 2,
      shape: 2,
      unique: 1,
    });
  });

  it("counts inherited-name ids with a prototype-free baseline", () => {
    const html = `
      <!doctype html><html><body>
        <div id="__proto__"></div><div id="__proto__"></div>
        <div id="constructor"></div><div id="constructor"></div>
        <div id="toString"></div><div id="toString"></div>
      </body></html>`;
    const baseline = countHtmlIds(parse(html));

    expect(Object.getPrototypeOf(baseline)).toBeNull();
    expect(baseline["__proto__"]).toBe(2);
    expect(baseline["constructor"]).toBe(2);
    expect(baseline["toString"]).toBe(2);
    expect(validateExport(html, baseline)).toEqual({ ok: true, errors: [] });
  });

  it("ignores inherited caller baseline counts when detecting new duplicates", () => {
    const inheritedCounts = Object.create(null) as Record<string, number>;
    inheritedCounts["__proto__"] = 99;
    inheritedCounts["constructor"] = 99;
    inheritedCounts["toString"] = 99;
    const baseline = Object.create(inheritedCounts) as Record<string, number>;
    const html = `
      <!doctype html><html><body>
        <div id="__proto__"></div><div id="__proto__"></div>
        <div id="constructor"></div><div id="constructor"></div>
        <div id="toString"></div><div id="toString"></div>
      </body></html>`;

    const result = validateExport(html, baseline);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "중복 HTML id가 증가했습니다: __proto__ (0 -> 2)",
      "중복 HTML id가 증가했습니다: constructor (0 -> 2)",
      "중복 HTML id가 증가했습니다: toString (0 -> 2)",
    ]);
  });

  it("removes editor artifacts, selection state, and runtime classes", () => {
    const document = parse(`
      <!doctype html><html><head></head><body>
        <div id="stage"><section class="slide active entered">
          <p class="copy revealed" data-step contenteditable="true"
             data-hse-temp-id="t1" data-hse-id="p1"
             data-hse-selected="true" data-hse-selection-state="editing"
             data-hse-selection-anchor="start">Text</p>
        </section></div>
        <aside data-hse-editor-artifact>Handles</aside>
        <script data-hse-editor-bridge>window.editorBridge = true;</script>
        <style id="hse-live-overrides">body { color: red; }</style>
      </body></html>`);

    const html = prepareExport(document, { overrides: {} });

    expect(html).not.toContain("data-hse-editor-bridge");
    expect(html).not.toContain("data-hse-editor-artifact");
    expect(html).not.toContain("hse-live-overrides");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("data-hse-temp-id");
    expect(html).not.toContain("data-hse-selected");
    expect(html).not.toContain("data-hse-selection-state");
    expect(html).not.toContain("data-hse-selection-anchor");
    expect(html).toContain('class="copy"');
    expect(html).toContain('data-hse-id="p1"');
    expect(html).not.toContain('id="hse-overrides"');
  });

  it("removes runtime classes only from slides and step elements", () => {
    const document = parse(`
      <!doctype html><html><body>
        <section class="slide active entered">
          <span data-step class="revealed">Step</span>
        </section>
        <nav class="active">Current page</nav>
        <div class="entered">Source animation state</div>
        <p class="revealed">Disclosed content</p>
      </body></html>`);

    const exported = parse(prepareExport(document, { overrides: {} }));

    expect(exported.querySelector(".slide")!.className).toBe("slide");
    expect(exported.querySelector("[data-step]")!.className).toBe("");
    expect(exported.querySelector("nav")!.className).toBe("active");
    expect(exported.querySelector("div")!.className).toBe("entered");
    expect(exported.querySelector("p")!.className).toBe("revealed");
  });

  it("preserves source CSS, JavaScript, and asset references", () => {
    const document = parse(`
      <!doctype html><html><head>
        <link rel="stylesheet" href="./deck.css">
        <style id="source-style">.slide { color: navy; }</style>
        <script src="./deck.js"></script>
      </head><body>
        <div id="stage"><section class="slide">
          <img src="./hero.png" alt="Hero">
        </section></div>
      </body></html>`);

    const html = prepareExport(document, { overrides: {} });

    expect(html).toContain('href="./deck.css"');
    expect(html).toContain(".slide { color: navy; }");
    expect(html).toContain('src="./deck.js"');
    expect(html).toContain('src="./hero.png"');
  });

  it("builds deterministic override CSS with safely escaped identifiers", () => {
    const css = buildOverrideCss({
      'z" node': {
        translate: "10px 20px",
        color: "red",
      },
      alpha: {
        "font-size": "16px",
        color: "blue",
      },
    });

    expect(css).toBe(
      [
        '[data-hse-id="alpha"] {',
        "  color: blue;",
        "  font-size: 16px;",
        "}",
        "[data-hse-id=\"z\\\"\\ node\"] {",
        "  color: red;",
        "  translate: 10px 20px;",
        "}",
      ].join("\n"),
    );
  });

  it("serializes supported CSS values through CSSStyleDeclaration", () => {
    expect(
      buildOverrideCss({
        "node-1": {
          width: "10.0px",
          color: "#ff0000",
        },
      }),
    ).toBe(
      [
        '[data-hse-id="node-1"] {',
        "  color: rgb(255, 0, 0);",
        "  width: 10px;",
        "}",
      ].join("\n"),
    );
  });

  it("rejects transform overrides so source transforms remain authoritative", () => {
    expect(() =>
      buildOverrideCss({
        "node-1": {
          transform: "translate(10px, 20px)",
        },
      }),
    ).toThrow("안전하지 않은 CSS override입니다.");
  });

  it("adds one override style only when safe declarations exist", () => {
    const document = parse(`
      <!doctype html><html><head>
        <style id="hse-overrides" data-hse-editor-overrides>stale</style>
      </head><body>
        <p data-hse-id="node-1">Text</p>
      </body></html>`);

    const html = prepareExport(document, {
      overrides: {
        empty: {},
        "node-1": { color: "rgb(10, 20, 30)" },
      },
    });
    const exported = parse(html);
    const styles = exported.querySelectorAll<HTMLStyleElement>(
      "style#hse-overrides",
    );

    expect(styles).toHaveLength(1);
    expect(styles[0].hasAttribute("data-hse-editor-overrides")).toBe(true);
    expect(styles[0].textContent).toBe(
      '[data-hse-id="node-1"] {\n  color: rgb(10, 20, 30);\n}',
    );
  });

  it("preserves permanent override CSS across export re-import and re-export", () => {
    const source = parse(`
      <!doctype html><html><head></head><body>
        <p data-hse-id="node-1">Text</p>
      </body></html>`);

    const firstExport = prepareExport(source, {
      overrides: { "node-1": { color: "red" } },
    });
    const reimported = parse(firstExport);
    const firstStyle = reimported.querySelector<HTMLStyleElement>(
      "style#hse-overrides[data-hse-editor-overrides]",
    )!;
    const secondExport = prepareExport(reimported, { overrides: {} });
    const secondStyle = parse(secondExport).querySelector<HTMLStyleElement>(
      "style#hse-overrides[data-hse-editor-overrides]",
    );

    expect(firstStyle).not.toBeNull();
    expect(secondStyle).not.toBeNull();
    expect(secondStyle!.textContent).toBe(firstStyle.textContent);
  });

  it("does not delete unmarked source elements that use reserved ids", () => {
    const document = parse(`
      <!doctype html><html><head>
        <style id="hse-live-overrides">temporary</style>
      </head><body>
        <div id="hse-overrides">Source content</div>
      </body></html>`);

    const html = prepareExport(document, { overrides: {} });

    expect(html).not.toContain(">temporary</style>");
    expect(html).toContain('<div id="hse-overrides">Source content</div>');
  });

  it.each([
    [{ "node-1": { "color}body": "red" } }, "property delimiter"],
    [{ "node-1": { color: "red; } body { display: none" } }, "rule breakout"],
    [
      { "node-1": { color: "</style><script>alert(1)</script>" } },
      "style element breakout",
    ],
    [{ "node-1": { opacity: "0.5" } }, "unsupported property"],
    [{ "node-1": { color: "red/*" } }, "unterminated comment"],
    [{ "node-1": { transform: "url(" } }, "unbalanced function"],
    [{ "node-1": { color: '"unterminated' } }, "unterminated quote"],
  ])(
    "rejects unsafe override CSS injection through %s",
    (overrides, _caseName) => {
      expect(() => buildOverrideCss(overrides)).toThrow(
        "안전하지 않은 CSS override입니다.",
      );
    },
  );

  it("reports residual editor state and duplicate ids in exported HTML", () => {
    const result = validateExport(`
      <!doctype html><html><head>
        <style id="hse-live-overrides"></style>
      </head><body>
        <section id="duplicate" class="slide active" data-hse-temp-id="t1"></section>
        <div id="duplicate" contenteditable="true"></div>
        <script data-hse-editor-bridge></script>
      </body></html>`, { duplicate: 1 });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "편집기 브리지 마커가 남아 있습니다.",
        "실시간 override 스타일이 남아 있습니다.",
        "임시 편집기 ID가 남아 있습니다.",
        "contenteditable 상태가 남아 있습니다.",
        "런타임 클래스가 남아 있습니다.",
        "중복 HTML id가 증가했습니다: duplicate (1 -> 2)",
      ]),
    );
  });

  it("allows baseline SVG duplicates and rejects only increased id counts", () => {
    const baselineHtml = `
      <!doctype html><html><head></head><body>
        <svg>
          <style>#shape { clip-path: url(#clip); }</style>
          <defs><clipPath id="clip"></clipPath></defs>
          <rect id="shape"></rect>
        </svg>
        <svg>
          <style>#shape { clip-path: url(#clip); }</style>
          <defs><clipPath id="clip"></clipPath></defs>
          <rect id="shape"></rect>
        </svg>
      </body></html>`;

    expect(
      validateExport(baselineHtml, { clip: 2, shape: 2 }),
    ).toEqual({ ok: true, errors: [] });

    const increasedHtml = baselineHtml.replace(
      "</body>",
      `
        <svg>
          <style>#shape { clip-path: url(#clip); }</style>
          <defs><clipPath id="clip"></clipPath></defs>
          <rect id="shape"></rect>
        </svg>
      </body>`,
    );
    const result = validateExport(increasedHtml, { clip: 2, shape: 2 });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "중복 HTML id가 증가했습니다: clip (2 -> 3)",
        "중복 HTML id가 증가했습니다: shape (2 -> 3)",
      ]),
    );
  });

  it("accepts a prepared export", () => {
    const document = parse(`
      <!doctype html><html><head></head><body>
        <div id="stage"><section class="slide">
          <p data-hse-id="p1">Text</p>
        </section></div>
      </body></html>`);
    const html = prepareExport(document, {
      overrides: { p1: { color: "green" } },
    });

    expect(validateExport(html, {})).toEqual({ ok: true, errors: [] });
  });
});
