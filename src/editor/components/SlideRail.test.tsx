import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideRail } from "./SlideRail";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SlideRail", () => {
  it("selects the requested slide and marks the active thumbnail", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SlideRail
        slideCount={3}
        activeSlide={2}
        previewUrl="blob:shared"
        onSelect={onSelect}
        onReorder={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "슬라이드 2 선택" }),
    ).toHaveAttribute("aria-current", "true");

    await user.click(
      screen.getByRole("button", { name: "슬라이드 3 선택" }),
    );
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("emits one-based duplicate and delete callbacks and protects the last slide", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const user = userEvent.setup();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const { rerender } = render(
      <SlideRail
        slideCount={2}
        activeSlide={1}
        previewUrl="blob:shared"
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "슬라이드 2 복제" }),
    );
    await user.click(
      screen.getByRole("button", { name: "슬라이드 2 삭제" }),
    );

    expect(onDuplicate).toHaveBeenCalledWith(2);
    expect(onDelete).toHaveBeenCalledWith(2);

    rerender(
      <SlideRail
        slideCount={1}
        activeSlide={1}
        previewUrl="blob:shared"
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );
    expect(
      screen.getByRole("button", { name: "슬라이드 1 삭제" }),
    ).toBeDisabled();
  });

  const mockSlideRects = () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function getRect(this: HTMLElement) {
      const item = this.closest(".slide-rail__item");
      const index = Number(
        item
          ?.querySelector(".slide-rail__number")
          ?.textContent ?? "1",
      );
      const top = (index - 1) * 136;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 182,
        bottom: top + 128,
        width: 182,
        height: 128,
        toJSON: () => ({}),
      };
    });
  };

  const keyboardReorder = async (
    handleName: string,
    movementCodes: string[],
  ) => {
    const handle = screen.getByRole("button", { name: handleName });
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const code of movementCodes) {
      fireEvent.keyDown(document, { key: code, code });
    }
    fireEvent.keyDown(document, { key: " ", code: "Space" });
  };

  it("emits zero-based indices when moving the first slide to the last position", async () => {
    mockSlideRects();
    const onReorder = vi.fn();
    render(
      <SlideRail
        slideCount={3}
        activeSlide={1}
        previewUrl="blob:shared"
        onSelect={vi.fn()}
        onReorder={onReorder}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await keyboardReorder("슬라이드 1 이동", [
      "ArrowDown",
      "ArrowDown",
    ]);

    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("emits zero-based indices when moving the last slide to the first position", async () => {
    mockSlideRects();
    const onReorder = vi.fn();
    render(
      <SlideRail
        slideCount={3}
        activeSlide={3}
        previewUrl="blob:shared"
        onSelect={vi.fn()}
        onReorder={onReorder}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await keyboardReorder("슬라이드 3 이동", [
      "ArrowUp",
      "ArrowUp",
    ]);

    expect(onReorder).toHaveBeenCalledWith(2, 0);
  });

  it("supports consecutive keyboard reorders in both directions", async () => {
    mockSlideRects();
    const onReorder = vi.fn();
    render(
      <SlideRail
        slideCount={2}
        activeSlide={1}
        previewUrl="blob:shared"
        onSelect={vi.fn()}
        onReorder={onReorder}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await keyboardReorder("슬라이드 1 이동", ["ArrowDown"]);
    await keyboardReorder("슬라이드 2 이동", ["ArrowUp"]);

    expect(onReorder.mock.calls).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("disables unsupported mutation controls without hiding the slides", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(
      <SlideRail
        slideCount={2}
        activeSlide={1}
        previewUrl="blob:shared"
        mutationsEnabled={false}
        selectionEnabled={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "슬라이드 1 선택" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "슬라이드 1 이동" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "슬라이드 1 복제" }),
    ).toBeDisabled();
  });
});
