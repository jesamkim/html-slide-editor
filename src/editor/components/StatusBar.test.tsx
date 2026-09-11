import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  it("announces export validation while preserving the open filename", () => {
    render(
      <StatusBar
        status="exporting"
        error={null}
        fileName="deck.html"
        activeSlide={1}
        slideCount={2}
        zoom={100}
        dirty
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "내보내기 파일을 검증하는 중입니다.",
    );
    expect(screen.getByText("deck.html *")).toBeVisible();
  });
});
