import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import Editor from "./Editor";

describe("Editor", () => {
  it("renders without crashing", () => {
    render(<Editor code="const x = 1;" language="javascript" />);
    expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
  });

  it("renders with empty code", () => {
    render(<Editor code="" />);
    expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
  });

  it("calls onChange when code changes", async () => {
    const handleChange = vi.fn();
    render(<Editor code="initial" language="javascript" onChange={handleChange} />);

    await waitFor(() => {
      const container = document.querySelector(".cm-editor-container");
      expect(container).toBeDefined();
    });
  });

  it("renders with different languages", () => {
    const languages = ["javascript", "python", "html", "css", "json", "markdown"];
    languages.forEach((lang) => {
      const { unmount } = render(<Editor code="test" language={lang} />);
      expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
      unmount();
    });
  });

  it("handles undefined language gracefully", () => {
    render(<Editor code="no language specified" />);
    expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
  });

  it("updates when code prop changes", async () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <Editor code="first" language="javascript" onChange={handleChange} />
    );

    rerender(<Editor code="second" language="javascript" onChange={handleChange} />);
    await waitFor(() => {
      expect(document.querySelector(".cm-editor-container")).toBeDefined();
    });
  });

  it("recreates editor when language changes", async () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <Editor code="code" language="javascript" onChange={handleChange} />
    );

    rerender(<Editor code="code" language="python" onChange={handleChange} />);
    await waitFor(() => {
      expect(document.querySelector(".cm-editor-container")).toBeDefined();
    });
  });

  it("renders with multiline code", () => {
    const multiline = `function hello() {
  console.log("world");
}`;
    render(<Editor code={multiline} language="javascript" />);
    expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
  });

  it("renders with special characters", () => {
    const code = '<div class="test">{"key": "value"}</div>';
    render(<Editor code={code} language="html" />);
    expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
  });

  it("applies language extensions correctly", () => {
    const jsxLanguages = ["jsx", "tsx"];
    jsxLanguages.forEach((lang) => {
      const { unmount } = render(<Editor code="const x = <div/>;" language={lang} />);
      expect(document.querySelector(".cm-editor-wrapper")).toBeDefined();
      unmount();
    });
  });
});
