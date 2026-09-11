import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("React Testing Library cleanup", () => {
  it("renders a marker in the first test", () => {
    render(<div data-testid="cleanup-marker" />);

    expect(screen.getByTestId("cleanup-marker")).toBeInTheDocument();
  });

  it("starts the next test with a clean document", () => {
    expect(screen.queryByTestId("cleanup-marker")).not.toBeInTheDocument();
  });
});
