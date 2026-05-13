import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FileTree from "./FileTree";
import { ToastProvider } from "./Toast";
import { mockInvoke, mockOpen, mockAsk } from "../setupTests";

describe("FileTree", () => {
  const defaultProps = {
    onFileOpen: vi.fn(),
    getActiveContent: vi.fn(() => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks({ implementations: false });
    mockOpen.mockResolvedValue("/test/project");
    mockAsk.mockResolvedValue(true);
  });

  const setupWithFolder = async (folderData: { name: string; children: unknown[] }) => {
    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce(folderData);
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree {...defaultProps} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });
  };

  it("renders Open Folder button when no nodes", () => {
    render(<FileTree {...defaultProps} />);
    expect(screen.getByText("Open Folder")).toBeDefined();
  });

  it("calls openFolder when button is clicked", async () => {
    mockInvoke.mockResolvedValueOnce(null);

    render(
      <ToastProvider>
        <FileTree {...defaultProps} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("scan_folder", { path: "/test/project" });
    });
  });

  it("reports the root name to the parent project component", async () => {
    const onRootNameChange = vi.fn();
    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({ name: "my-project", children: [] });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree {...defaultProps} onRootNameChange={onRootNameChange} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(onRootNameChange).toHaveBeenCalledWith("my-project");
    });
    expect(screen.queryByText("my-project")).not.toBeInTheDocument();
  });

  it("renders file nodes correctly", async () => {
    await setupWithFolder({
      name: "project",
      children: [
        { name: "file.txt", isDir: false },
        { name: "src", isDir: true, children: [{ name: "main.js", isDir: false }] },
      ],
    });

    expect(screen.getByText("file.txt")).toBeDefined();
  });

  it("renders folder nodes with expand icon", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });

    expect(screen.getByText("src")).toBeDefined();
  });

  it("toggles folder expansion on click", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "src", isDir: true, children: [{ name: "main.js", isDir: false }] }],
    });

    expect(screen.queryByText("main.js")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("main.js")).toBeDefined();
    });
  });

  it("calls onFileOpen when file is clicked", async () => {
    const onFileOpen = vi.fn();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce("file content");

    render(
      <ToastProvider>
        <FileTree onFileOpen={onFileOpen} getActiveContent={() => undefined} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeDefined();
    });

    fireEvent.click(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "file.txt", content: "file content" })
      );
    });
  });

  it("uses in-memory content when available", async () => {
    const onFileOpen = vi.fn();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree
          onFileOpen={onFileOpen}
          getActiveContent={() => "in-memory content"}
        />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeDefined();
    });

    fireEvent.click(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ content: "in-memory content" })
      );
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
  });

  it("shows context menu on right-click", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Open")).toBeDefined();
    });
  });

  it("handles rename dialog", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Rename")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() => {
      expect(screen.getByText(/New name for/)).toBeDefined();
    });
  });

  it("handles new file creation", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });

    fireEvent.contextMenu(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("New File...")).toBeDefined();
    });

    fireEvent.click(screen.getByText("New File..."));

    await waitFor(() => {
      expect(screen.getByText(/File name/)).toBeDefined();
    });
  });

  it("handles new folder creation", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });

    fireEvent.contextMenu(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("New Folder...")).toBeDefined();
    });

    fireEvent.click(screen.getByText("New Folder..."));

    await waitFor(() => {
      expect(screen.getByText(/Folder name/)).toBeDefined();
    });
  });

  it("handles delete with confirmation", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_path", { relativePath: "file.txt" });
    });
  });

  it("handles file copy", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Copy")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("copy_file", { relativePath: "file.txt" });
    });
  });

  it("handles save file", async () => {
    const onFileOpen = vi.fn();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree
          onFileOpen={onFileOpen}
          getActiveContent={() => "content to save"}
        />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeDefined();
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("write_file", {
        relativePath: "file.txt",
        content: "content to save",
      });
    });
  });

  it("applies custom className", () => {
    render(<FileTree {...defaultProps} className="hidden" />);
    expect(document.querySelector(".file-tree-panel")).toHaveClass("hidden");
  });

  it("handles auto-open on mount", async () => {
    mockInvoke.mockResolvedValueOnce("/last/path");
    mockInvoke.mockResolvedValueOnce({
      name: "last-project",
      children: [],
    });
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree {...defaultProps} />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });
  });

  it("handles scan_folder error gracefully", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Permission denied"));

    render(
      <ToastProvider>
        <FileTree {...defaultProps} />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Failed to open last folder/)).toBeDefined();
    });
  });

  it("handles read_file error gracefully", async () => {
    const onFileOpen = vi.fn();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);
    mockInvoke.mockRejectedValueOnce(new Error("File not found"));

    render(
      <ToastProvider>
        <FileTree onFileOpen={onFileOpen} getActiveContent={() => undefined} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeDefined();
    });

    fireEvent.click(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText(/Failed to read file/)).toBeDefined();
    });

    expect(onFileOpen).not.toHaveBeenCalled();
  });

  it("builds correct paths for nested nodes", async () => {
    const onFileOpen = vi.fn();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [
        {
          name: "src",
          isDir: true,
          children: [
            { name: "components", isDir: true, children: [{ name: "App.tsx", isDir: false }] },
          ],
        },
      ],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce([]);

    render(
      <ToastProvider>
        <FileTree onFileOpen={onFileOpen} getActiveContent={() => undefined} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("src")).toBeDefined();
    });

    fireEvent.click(screen.getByText("src"));
    await waitFor(() => screen.getByText("components"));

    fireEvent.click(screen.getByText("components"));
    await waitFor(() => screen.getByText("App.tsx"));

    fireEvent.click(screen.getByText("App.tsx"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("read_file", {
        relativePath: "src/components/App.tsx",
      });
    });
  });

  it("preserves expanded state across renders", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce(["src"]);

    render(
      <ToastProvider>
        <FileTree {...defaultProps} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(screen.getByText("src")).toBeDefined();
    });

    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_expanded_state", expect.anything());
    });
  });

  it("handles empty folder", async () => {
    await setupWithFolder({ name: "empty-project", children: [] });

    expect(document.querySelector(".tree-content")).toBeInTheDocument();
  });

  it("handles folder open cancellation", async () => {
    mockOpen.mockResolvedValue(null);

    render(<FileTree {...defaultProps} />);
    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalledWith("scan_folder", expect.anything());
    });
  });

  it("handles refresh tree after operations", async () => {
    await setupWithFolder({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Copy")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("copy_file", { relativePath: "file.txt" });
    });

    expect(mockInvoke).toHaveBeenCalledWith("scan_folder", expect.anything());
  });
});
