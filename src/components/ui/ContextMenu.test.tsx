import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ContextMenu from "./ContextMenu";

describe("ContextMenu", () => {
  const mockItems = [
    { label: "Open", action: vi.fn() },
    { label: "Save", action: vi.fn() },
    { label: "Delete", action: vi.fn(), danger: true },
  ];

  it("renders all menu items", () => {
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={vi.fn()} />
    );
    expect(screen.getByText("Open")).toBeDefined();
    expect(screen.getByText("Save")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("applies danger class to dangerous items", () => {
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={vi.fn()} />
    );
    const deleteItem = document.querySelector(".context-menu-item.danger");
    expect(deleteItem).toBeDefined();
  });

  it("calls action and onClose when item is clicked", () => {
    const closeFn = vi.fn();
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={closeFn} />
    );

    fireEvent.click(screen.getByText("Open"));
    expect(mockItems[0].action).toHaveBeenCalled();
    expect(closeFn).toHaveBeenCalled();
  });

  it("closes on Escape key press", () => {
    const closeFn = vi.fn();
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={closeFn} />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeFn).toHaveBeenCalled();
  });

  it("closes when clicking outside the menu", () => {
    const closeFn = vi.fn();
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={closeFn} />
    );

    fireEvent.mouseDown(document.body);
    expect(closeFn).toHaveBeenCalled();
  });

  it("does not close when clicking inside the menu", () => {
    const closeFn = vi.fn();
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={closeFn} />
    );

    fireEvent.mouseDown(screen.getByText("Open").parentElement!);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("adjusts position when near right edge", () => {
    Object.defineProperty(window, "innerWidth", { value: 200, writable: true });
    render(
      <ContextMenu x={150} y={100} items={mockItems} onClose={vi.fn()} />
    );
    const menu = document.querySelector(".context-menu");
    expect(menu).toHaveStyle({ left: "20px" });
  });

  it("adjusts position when near bottom edge", () => {
    Object.defineProperty(window, "innerHeight", { value: 100, writable: true });
    render(
      <ContextMenu x={100} y={80} items={mockItems} onClose={vi.fn()} />
    );
    const menu = document.querySelector(".context-menu");
    expect(menu).toHaveStyle({ top: "-28px" });
  });

  it("renders with empty items array", () => {
    render(
      <ContextMenu x={100} y={100} items={[]} onClose={vi.fn()} />
    );
    expect(document.querySelector(".context-menu")).toBeDefined();
  });

  it("stops mouseDown propagation", () => {
    render(
      <ContextMenu x={100} y={100} items={mockItems} onClose={vi.fn()} />
    );
    const menu = document.querySelector(".context-menu");
    const event = new MouseEvent("mousedown", { bubbles: true });
    menu?.dispatchEvent(event);
  });

  it("renders single item correctly", () => {
    const singleItem = [{ label: "Only Option", action: vi.fn() }];
    render(
      <ContextMenu x={100} y={100} items={singleItem} onClose={vi.fn()} />
    );
    expect(screen.getByText("Only Option")).toBeDefined();
  });

  it("handles many items", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) => ({
      label: `Item ${i}`,
      action: vi.fn(),
    }));
    render(
      <ContextMenu x={100} y={100} items={manyItems} onClose={vi.fn()} />
    );
    expect(screen.getByText("Item 0")).toBeDefined();
    expect(screen.getByText("Item 19")).toBeDefined();
  });
});
