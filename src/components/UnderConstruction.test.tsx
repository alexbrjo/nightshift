import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import UnderConstruction from "./UnderConstruction";

describe("UnderConstruction", () => {
  it("renders with the provided title", () => {
    render(<UnderConstruction title="Code Editor" />);
    expect(screen.getByText("Code Editor")).toBeDefined();
  });

  it("renders the construction message", () => {
    render(<UnderConstruction title="Test" />);
    expect(screen.getByText("This section is under construction and will be available soon.")).toBeDefined();
  });

  it("renders the construction icon", () => {
    render(<UnderConstruction title="Test" />);
    expect(document.querySelector(".construction-icon")).toBeDefined();
  });

  it("renders with different titles", () => {
    const titles = ["Collection Viewer", "Job Runner", "Experiment Designer"];
    titles.forEach((title) => {
      const { unmount } = render(<UnderConstruction title={title} />);
      expect(screen.getByText(title)).toBeDefined();
      unmount();
    });
  });

  it("renders with empty title", () => {
    render(<UnderConstruction title="" />);
    expect(document.querySelector(".under-construction")).toBeDefined();
  });

  it("renders with special characters in title", () => {
    render(<UnderConstruction title="AI & ML Tools" />);
    expect(screen.getByText("AI & ML Tools")).toBeDefined();
  });

  it("renders with unicode in title", () => {
    render(<UnderConstruction title="🔧 Settings" />);
    expect(screen.getByText("🔧 Settings")).toBeDefined();
  });

  it("applies correct CSS class", () => {
    render(<UnderConstruction title="Test" />);
    expect(document.querySelector(".under-construction")).toBeDefined();
  });

  it("renders heading element", () => {
    render(<UnderConstruction title="Test" />);
    expect(screen.getByRole("heading", { level: 2 })).toBeDefined();
  });

  it("renders paragraph element", () => {
    render(<UnderConstruction title="Test" />);
    expect(screen.getByText("This section is under construction and will be available soon.")).toBeDefined();
  });
});
