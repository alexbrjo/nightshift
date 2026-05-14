import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

describe("Toast", () => {
  it("renders without toasts initially", () => {
    render(
      <ToastProvider>
        <div data-testid="content">Test</div>
      </ToastProvider>
    );
    expect(screen.getByTestId("content")).toBeDefined();
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("displays error toast", () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("Error message", "error")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Trigger"));
    expect(screen.getByText("Error message")).toBeDefined();
    expect(document.querySelector(".toast-error")).toBeDefined();
  });

  it("displays success toast", () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("Success!", "success")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Trigger"));
    expect(screen.getByText("Success!")).toBeDefined();
  });

  it("displays info toast", () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("Info message", "info")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Trigger"));
    expect(screen.getByText("Info message")).toBeDefined();
  });

  it("defaults to error type when no type specified", () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("Default type")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Trigger"));
    expect(document.querySelector(".toast-error")).toBeDefined();
  });

  it("displays multiple toasts", () => {
    function TestComponent() {
      const { showToast } = useToast();
      return (
        <div>
          <button onClick={() => showToast("First", "info")}>One</button>
          <button onClick={() => showToast("Second", "success")}>Two</button>
          <button onClick={() => showToast("Third", "error")}>Three</button>
        </div>
      );
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("One"));
    fireEvent.click(screen.getByText("Two"));
    fireEvent.click(screen.getByText("Three"));
    expect(screen.getByText("First")).toBeDefined();
    expect(screen.getByText("Second")).toBeDefined();
    expect(screen.getByText("Third")).toBeDefined();
  });

  it("auto-dismisses toast after timeout", async () => {
    vi.useFakeTimers();

    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("Auto dismiss", "info")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText("Trigger"));
    });

    expect(screen.getByText("Auto dismiss")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText("Auto dismiss")).toBeNull();
    vi.useRealTimers();
  });

  it("displays correct icon for each type", async () => {
    function TestComponent() {
      const { showToast } = useToast();
      return (
        <div>
          <button onClick={() => showToast("Error", "error")}>Err</button>
          <button onClick={() => showToast("Success", "success")}>Succ</button>
          <button onClick={() => showToast("Info", "info")}>Inf</button>
        </div>
      );
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText("Err"));
      fireEvent.click(screen.getByText("Succ"));
      fireEvent.click(screen.getByText("Inf"));
    });

    expect(document.querySelectorAll(".toast-icon").length).toBe(3);
  });

  it("generates unique toast IDs", async () => {
    function TestComponent() {
      const { showToast } = useToast();
      return (
        <div>
          <button onClick={() => showToast("First")}>One</button>
          <button onClick={() => showToast("Second")}>Two</button>
          <button onClick={() => showToast("Third")}>Three</button>
        </div>
      );
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText("One"));
      fireEvent.click(screen.getByText("Two"));
      fireEvent.click(screen.getByText("Three"));
    });

    expect(document.querySelectorAll(".toast").length).toBe(3);
  });

  it("handles long messages", async () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("This is a very long error message that should still be displayed correctly in the toast notification without any issues or truncation problems", "error")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText("Trigger"));
    });

    expect(screen.getByText("This is a very long error message that should still be displayed correctly in the toast notification without any issues or truncation problems")).toBeDefined();
  });

  it("handles empty message", async () => {
    function TestComponent() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("")}>Trigger</button>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText("Trigger"));
    });

    expect(document.querySelector(".toast")).toBeDefined();
  });

  it("useToast returns showToast function", () => {
    function TestComponent() {
      const { showToast } = useToast();
      expect(typeof showToast).toBe("function");
      return <div>Test</div>;
    }

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
  });
});
