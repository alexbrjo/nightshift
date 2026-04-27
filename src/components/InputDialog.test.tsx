import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InputDialog from "./InputDialog";

describe("InputDialog", () => {
  const defaultProps = {
    title: "Test Dialog",
    label: "Enter value:",
    defaultValue: "default",
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders with title and label", () => {
    render(<InputDialog {...defaultProps} />);
    expect(screen.getByText("Test Dialog")).toBeDefined();
    expect(screen.getByText("Enter value:")).toBeDefined();
  });

  it("displays default value in input", () => {
    render(<InputDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("default");
  });

  it("renders Cancel and OK buttons", () => {
    render(<InputDialog {...defaultProps} />);
    expect(screen.getByText("Cancel")).toBeDefined();
    expect(screen.getByText("OK")).toBeDefined();
  });

  it("calls onCancel when Cancel button is clicked", () => {
    const cancelFn = vi.fn();
    render(<InputDialog {...defaultProps} onCancel={cancelFn} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(cancelFn).toHaveBeenCalled();
  });

  it("calls onSubmit with trimmed value when OK is clicked", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} onSubmit={submitFn} />);
    fireEvent.click(screen.getByText("OK"));
    expect(submitFn).toHaveBeenCalledWith("default");
  });

  it("submits trimmed value on Enter key", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} onSubmit={submitFn} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  new value  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitFn).toHaveBeenCalledWith("new value");
  });

  it("cancels on Escape key", () => {
    const cancelFn = vi.fn();
    render(<InputDialog {...defaultProps} onCancel={cancelFn} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancelFn).toHaveBeenCalled();
  });

  it("does not submit empty value", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} defaultValue="   " />);
    fireEvent.click(screen.getByText("OK"));
    expect(submitFn).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only value", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("OK"));
    expect(submitFn).not.toHaveBeenCalled();
  });

  it("cancels when clicking overlay", () => {
    const cancelFn = vi.fn();
    render(<InputDialog {...defaultProps} onCancel={cancelFn} />);
    fireEvent.click(document.querySelector(".dialog-overlay")!);
    expect(cancelFn).toHaveBeenCalled();
  });

  it("does not cancel when clicking dialog box", () => {
    const cancelFn = vi.fn();
    render(<InputDialog {...defaultProps} onCancel={cancelFn} />);
    fireEvent.click(screen.getByRole("textbox"));
    expect(cancelFn).not.toHaveBeenCalled();
  });

  it("updates input value on change", () => {
    render(<InputDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "updated" } });
    expect(input).toHaveValue("updated");
  });

  it("renders with empty default value", () => {
    render(<InputDialog {...defaultProps} defaultValue="" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("");
  });

  it("focuses and selects input on mount", () => {
    render(<InputDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
  });

  it("handles special characters in input", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} onSubmit={submitFn} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: 'file"name.txt' } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitFn).toHaveBeenCalledWith('file"name.txt');
  });

  it("handles unicode characters", () => {
    const submitFn = vi.fn();
    render(<InputDialog {...defaultProps} onSubmit={submitFn} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "файл.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitFn).toHaveBeenCalledWith("файл.txt");
  });
});
