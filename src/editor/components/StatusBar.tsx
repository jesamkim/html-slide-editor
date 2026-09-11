import type { EditorStatus } from "../state/editorReducer";

export interface StatusBarProps {
  status: EditorStatus;
  error: string | null;
  fileName: string | null;
  activeSlide: number;
  slideCount: number;
  zoom: number;
  dirty: boolean;
}

export function StatusBar({
  status,
  error,
  fileName,
  activeSlide,
  slideCount,
  zoom,
  dirty,
}: StatusBarProps) {
  return (
    <footer className="status-bar" aria-label="편집기 상태">
      <div className="status-bar__primary">
        {status === "loading" ? (
          <span role="status">HTML을 불러오는 중입니다.</span>
        ) : (
          <>
            <span className="status-bar__file">
              {fileName ?? "열린 파일 없음"}
              {dirty ? " *" : ""}
            </span>
            {status === "exporting" ? (
              <span role="status">
                내보내기 파일을 검증하는 중입니다.
              </span>
            ) : null}
          </>
        )}
        {error ? <span role="alert">{error}</span> : null}
      </div>
      <div className="status-bar__metrics">
        <span>
          슬라이드 {slideCount > 0 ? activeSlide : 0} / {slideCount}
        </span>
        <span>{zoom}%</span>
      </div>
    </footer>
  );
}
