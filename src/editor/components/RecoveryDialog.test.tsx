import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryRecord } from "../../core/persistence/sessionStore";
import { RecoveryDialog } from "./RecoveryDialog";

const recovery = (
  overrides: Partial<RecoveryRecord> = {},
): RecoveryRecord => ({
  id: "recovery-1",
  fileName: "quarterly-review.html",
  fingerprint: "saved-fingerprint",
  baselineIdCounts: { intro: 1 },
  html: "<!doctype html><html><body><main id=\"stage\"></main></body></html>",
  activeSlide: 1,
  overrides: {},
  commands: [],
  historyCursor: 0,
  exportedAt: null,
  updatedAt: Date.UTC(2026, 8, 2, 3, 4, 5),
  ...overrides,
});

describe("RecoveryDialog", () => {
  it("shows the filename and saved timestamp without restoring automatically", () => {
    const record = recovery();
    const onRestore = vi.fn();
    const onDiscard = vi.fn();

    render(
      <RecoveryDialog
        recovery={record}
        currentFingerprint={null}
        onRestore={onRestore}
        onDiscard={onDiscard}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "편집 세션 복구" }),
    ).toBeVisible();
    expect(screen.getByText("quarterly-review.html")).toBeVisible();
    expect(screen.getByText(new Date(record.updatedAt).toLocaleString())).toBeVisible();
    expect(screen.getByText(new Date(record.updatedAt).toLocaleString()))
      .toHaveAttribute("dateTime", new Date(record.updatedAt).toISOString());
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("restores only after the explicit restore button is clicked", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();

    render(
      <RecoveryDialog
        recovery={recovery()}
        currentFingerprint={null}
        onRestore={onRestore}
        onDiscard={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "세션 복구" }));

    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("discards only after the explicit discard button is clicked", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();

    render(
      <RecoveryDialog
        recovery={recovery()}
        currentFingerprint={null}
        onRestore={vi.fn()}
        onDiscard={onDiscard}
      />,
    );

    await user.click(screen.getByRole("button", { name: "복구 기록 삭제" }));

    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("warns when the open file fingerprint differs from the recovery", () => {
    render(
      <RecoveryDialog
        recovery={recovery()}
        currentFingerprint="current-fingerprint"
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "현재 열린 파일과 원본 지문이 다릅니다.",
    );
  });

  it("focuses the restore action and traps forward and reverse Tab", async () => {
    const user = userEvent.setup();
    render(
      <RecoveryDialog
        recovery={recovery()}
        currentFingerprint={null}
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    const discard = screen.getByRole("button", {
      name: "복구 기록 삭제",
    });
    const restore = screen.getByRole("button", { name: "세션 복구" });

    expect(restore).toHaveFocus();

    await user.tab();
    expect(discard).toHaveFocus();

    await user.tab({ shift: true });
    expect(restore).toHaveFocus();
  });

  it("restores prior focus after an action closes the dialog", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            복구 열기
          </button>
          {open ? (
            <RecoveryDialog
              recovery={recovery()}
              currentFingerprint={null}
              onRestore={() => setOpen(false)}
              onDiscard={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "복구 열기" });
    opener.focus();
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "세션 복구" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
