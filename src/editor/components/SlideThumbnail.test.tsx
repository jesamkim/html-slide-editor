import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideThumbnail } from "./SlideThumbnail";

type ObserverCallback = ConstructorParameters<
  typeof IntersectionObserver
>[0];

let observerCallback: ObserverCallback | null = null;
let disconnect = vi.fn();

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "148px 0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = disconnect;
  takeRecords = () => [];

  constructor(callback: ObserverCallback) {
    observerCallback = callback;
  }
}

const intersect = (isIntersecting: boolean) => {
  act(() => {
    observerCallback?.(
      [
        {
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          target: document.querySelector(".slide-thumbnail")!,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
          time: 0,
        },
      ],
      {} as IntersectionObserver,
    );
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  observerCallback = null;
  disconnect = vi.fn();
});

describe("SlideThumbnail", () => {
  it("mounts one shared preview URL with a one-based hash when intersecting", () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    render(
      <SlideThumbnail
        index={2}
        previewUrl="blob:shared-preview"
        active={false}
        fallbackVisible={false}
      />,
    );

    expect(
      screen.queryByTitle("슬라이드 2 미리보기"),
    ).not.toBeInTheDocument();

    intersect(true);

    expect(screen.getByTitle("슬라이드 2 미리보기")).toHaveAttribute(
      "src",
      "blob:shared-preview#2",
    );
    expect(screen.getByTitle("슬라이드 2 미리보기")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    expect(screen.getByTitle("슬라이드 2 미리보기")).toHaveClass(
      "slide-thumbnail__frame",
    );
  });

  it("unmounts iframe contents after leaving the observed overscan range", () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    render(
      <SlideThumbnail
        index={1}
        previewUrl="blob:shared-preview"
        active={false}
        fallbackVisible={false}
      />,
    );

    intersect(true);
    expect(screen.getByTitle("슬라이드 1 미리보기")).toBeInTheDocument();

    intersect(false);
    expect(
      screen.queryByTitle("슬라이드 1 미리보기"),
    ).not.toBeInTheDocument();
  });

  it("uses the deterministic fallback hint when IntersectionObserver is missing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { rerender } = render(
      <SlideThumbnail
        index={3}
        previewUrl="blob:shared-preview"
        active={false}
        fallbackVisible={false}
      />,
    );

    expect(
      screen.queryByTitle("슬라이드 3 미리보기"),
    ).not.toBeInTheDocument();

    rerender(
      <SlideThumbnail
        index={3}
        previewUrl="blob:shared-preview"
        active
        fallbackVisible
      />,
    );
    expect(screen.getByTitle("슬라이드 3 미리보기")).toBeInTheDocument();
  });

  it("keeps an offscreen active thumbnail unmounted when observer support exists", () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    render(
      <SlideThumbnail
        index={9}
        previewUrl="blob:shared-preview"
        active
        fallbackVisible
      />,
    );

    intersect(false);

    expect(
      screen.queryByTitle("슬라이드 9 미리보기"),
    ).not.toBeInTheDocument();
  });
});
