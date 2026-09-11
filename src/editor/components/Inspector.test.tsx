import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "../../core/document/types";
import { Inspector } from "./Inspector";

const textSelection: SelectionSnapshot = {
  targetId: "heading-1",
  path: ["section.slide", "h1"],
  bounds: { x: 100, y: 120, width: 640, height: 120 },
  kind: "text",
  text: "Quarterly results",
  styles: {
    fontSize: "48px",
    color: "#1f2933",
    fontWeight: "400",
    textAlign: "left",
  },
};

describe("Inspector", () => {
  it("emits one exact text style patch", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Inspector selection={textSelection} onPatch={onPatch} />);

    await user.clear(screen.getByLabelText("글자 크기"));
    await user.type(screen.getByLabelText("글자 크기"), "72");
    await user.click(screen.getByRole("button", { name: "적용" }));

    expect(onPatch).toHaveBeenCalledOnce();
    expect(onPatch).toHaveBeenCalledWith({ fontSize: "72px" });
  });

  it("emits changed content, weight, color, and segmented alignment only", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Inspector selection={textSelection} onPatch={onPatch} />);

    await user.clear(screen.getByLabelText("텍스트 내용"));
    await user.type(screen.getByLabelText("텍스트 내용"), "Revenue");
    await user.click(screen.getByRole("button", { name: "굵게" }));
    await user.click(screen.getByRole("button", { name: "가운데 정렬" }));
    fireEventColor(screen.getByLabelText("글자 색상"), "#0f766e");
    await user.click(screen.getByRole("button", { name: "적용" }));

    expect(onPatch).toHaveBeenCalledWith({
      text: "Revenue",
      color: "#0f766e",
      fontWeight: "700",
      textAlign: "center",
    });
  });

  it("preserves consecutive font size and color events before render", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Inspector selection={textSelection} onPatch={onPatch} />);

    fireEvent.change(screen.getByLabelText("글자 크기"), {
      target: { value: "72" },
    });
    fireEvent.change(screen.getByLabelText("글자 색상"), {
      target: { value: "#0f766e" },
    });
    expect(screen.getByLabelText("글자 크기")).toHaveValue(72);
    expect(screen.getByLabelText("글자 색상")).toHaveValue("#0f766e");
    await user.click(screen.getByRole("button", { name: "적용" }));

    expect(onPatch).toHaveBeenCalledWith({
      fontSize: "72px",
      color: "#0f766e",
    });
  });

  it("emits numeric arrange patches and object callbacks", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    render(
      <Inspector
        selection={textSelection}
        onPatch={onPatch}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "배치" }));
    await user.clear(screen.getByLabelText("X 위치"));
    await user.type(screen.getByLabelText("X 위치"), "240");
    await user.clear(screen.getByLabelText("너비"));
    await user.type(screen.getByLabelText("너비"), "800");
    await user.click(screen.getByRole("button", { name: "적용" }));
    await user.click(screen.getByRole("button", { name: "선택 항목 복제" }));
    await user.click(screen.getByRole("button", { name: "선택 항목 삭제" }));

    expect(onPatch).toHaveBeenCalledWith({
      translateX: 240,
      width: 800,
    });
    expect(onDuplicate).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("disables unavailable controls instead of presenting decorative actions", () => {
    render(<Inspector selection={textSelection} disabled />);

    expect(screen.getByLabelText("글자 크기")).toBeDisabled();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "선택 항목 복제" }),
    ).toBeDisabled();
  });

  it("does not emit a patch for untouched fractional geometry", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <Inspector
        selection={{
          ...textSelection,
          bounds: {
            x: 100.5,
            y: 120.25,
            width: 640.4,
            height: 119.75,
          },
        }}
        onPatch={onPatch}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "배치" }));
    expect(screen.getByLabelText("X 위치")).toHaveValue(100.5);
    expect(screen.getByLabelText("너비")).toHaveValue(640.4);

    await user.click(screen.getByRole("button", { name: "적용" }));

    expect(onPatch).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-1", "NaN", "Infinity"])(
    "rejects invalid font size draft %j",
    (value) => {
      const onPatch = vi.fn();
      render(<Inspector selection={textSelection} onPatch={onPatch} />);
      const input = screen.getByLabelText("글자 크기");

      fireEvent.change(input, { target: { value } });

      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
      expect(onPatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "X 위치", value: "" },
    { label: "X 위치", value: "NaN" },
    { label: "X 위치", value: "Infinity" },
    { label: "너비", value: "" },
    { label: "너비", value: "-1" },
    { label: "너비", value: "Infinity" },
    { label: "높이", value: "-0.5" },
  ])("rejects invalid arrange draft $label=$value", async ({ label, value }) => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Inspector selection={textSelection} onPatch={onPatch} />);
    await user.click(screen.getByRole("tab", { name: "배치" }));
    const input = screen.getByLabelText(label);

    fireEvent.change(input, { target: { value } });

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("accepts finite negative coordinates and zero dimensions", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Inspector selection={textSelection} onPatch={onPatch} />);
    await user.click(screen.getByRole("tab", { name: "배치" }));

    fireEvent.change(screen.getByLabelText("X 위치"), {
      target: { value: "-12.5" },
    });
    fireEvent.change(screen.getByLabelText("너비"), {
      target: { value: "0" },
    });

    expect(screen.getByRole("button", { name: "적용" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onPatch).toHaveBeenCalledWith({
      translateX: -12.5,
      width: 0,
    });
  });

  it("implements roving keyboard tabs and explicit panel relationships", async () => {
    const user = userEvent.setup();
    render(<Inspector selection={textSelection} onPatch={vi.fn()} />);
    const textTab = screen.getByRole("tab", { name: "텍스트" });
    const arrangeTab = screen.getByRole("tab", { name: "배치" });
    const textPanel = screen.getByRole("tabpanel");

    expect(textTab).toHaveAttribute("tabindex", "0");
    expect(arrangeTab).toHaveAttribute("tabindex", "-1");
    expect(textTab).toHaveAttribute("aria-controls", textPanel.id);
    expect(textPanel).toHaveAttribute("aria-labelledby", textTab.id);
    expect(
      document.getElementById(arrangeTab.getAttribute("aria-controls")!),
    ).toHaveAttribute("hidden");

    textTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(arrangeTab).toHaveFocus();
    expect(arrangeTab).toHaveAttribute("aria-selected", "true");
    const arrangePanel = screen.getByRole("tabpanel");
    expect(arrangeTab).toHaveAttribute("aria-controls", arrangePanel.id);
    expect(arrangePanel).toHaveAttribute("aria-labelledby", arrangeTab.id);

    await user.keyboard("{Home}");
    expect(textTab).toHaveFocus();
    expect(textTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(arrangeTab).toHaveFocus();
    expect(arrangeTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(textTab).toHaveFocus();
    expect(textTab).toHaveAttribute("aria-selected", "true");
  });
});

function fireEventColor(element: HTMLElement, value: string) {
  element.dispatchEvent(
    new Event("input", { bubbles: true }),
  );
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(element, value);
  element.dispatchEvent(
    new Event("change", { bubbles: true }),
  );
}
