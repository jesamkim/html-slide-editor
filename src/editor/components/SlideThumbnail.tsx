import { useEffect, useRef, useState } from "react";

export interface SlideThumbnailProps {
  index: number;
  previewUrl: string | null;
  active: boolean;
  fallbackVisible: boolean;
}

const hasIntersectionObserver = () =>
  typeof globalThis.IntersectionObserver === "function";

export function SlideThumbnail({
  index,
  previewUrl,
  active,
  fallbackVisible,
}: SlideThumbnailProps) {
  const observerAvailable = hasIntersectionObserver();
  const rootRef = useRef<HTMLDivElement>(null);
  const [intersecting, setIntersecting] = useState(
    () => !observerAvailable && fallbackVisible,
  );

  useEffect(() => {
    if (!hasIntersectionObserver()) {
      setIntersecting(fallbackVisible);
      return;
    }

    const root = rootRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setIntersecting(entries.some((entry) => entry.isIntersecting));
      },
      {
        root: root.closest(".slide-rail__scroll"),
        rootMargin: "148px 0px",
        threshold: 0,
      },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [fallbackVisible]);

  const shouldMount =
    Boolean(previewUrl) &&
    (observerAvailable ? intersecting : fallbackVisible);

  return (
    <div
      ref={rootRef}
      className="slide-thumbnail"
      data-active={active ? "true" : "false"}
    >
      {shouldMount ? (
        <iframe
          className="slide-thumbnail__frame"
          title={`슬라이드 ${index} 미리보기`}
          src={`${previewUrl}#${index}`}
          sandbox="allow-scripts"
          tabIndex={-1}
        />
      ) : (
        <div className="slide-thumbnail__placeholder" aria-hidden="true" />
      )}
    </div>
  );
}
