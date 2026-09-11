import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeckFrameHandle } from "../../bridge/DeckFrame";
import { CanvasStage } from "./CanvasStage";

describe("CanvasStage", () => {
  it("maps iframe stage bounds into a same-document proxy rectangle", () => {
    const frameRef = createRef<DeckFrameHandle>();
    render(
      <CanvasStage
        frameRef={frameRef}
        srcDoc="<!doctype html><html></html>"
        recoverySrcDoc="<!doctype html><html></html>"
        token="session-1"
        stageSize={{ width: 1920, height: 1080 }}
        selection={{
          targetId: "node-1",
          path: ["section.slide", "h1"],
          bounds: { x: 192, y: 108, width: 384, height: 216 },
          kind: "text",
          text: "Title",
          styles: null,
        }}
        onMessage={() => {}}
        onCommit={() => {}}
      />,
    );
    const frame = screen.getByTitle("편집 중인 슬라이드");
    frame.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 960,
        height: 540,
        x: 100,
        y: 50,
        right: 1060,
        bottom: 590,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByTestId("selection-proxy")).toHaveStyle({
      left: "196px",
      top: "104px",
      width: "192px",
      height: "108px",
    });
  });
});
