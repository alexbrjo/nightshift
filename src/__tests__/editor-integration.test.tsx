import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FileTree from "../components/FileTree";
import { ToastProvider } from "../components/Toast";
import { mockInvoke, mockOpen, mockAsk } from "../setupTests";

describe("Editor file operations integration", () => {
  const createOnFileOpen = () => vi.fn();
  const createGetActiveContent = (contentMap?: Map<string, string>) => {
    return vi.fn((path?: string) => path ? contentMap?.get(path) ?? undefined : undefined);
  };

  beforeEach(() => {
    vi.clearAllMocks({ implementations: false });
    mockOpen.mockResolvedValue("/test/project");
    mockAsk.mockResolvedValue(true);
  });

  const renderWithToast = (ui: React.ReactElement) => {
    return render(<ToastProvider>{ui}</ToastProvider>);
  };

  it("opens folder and reads file content", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null); // load_last_folder
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "hello.txt", isDir: false }],
    }); // scan_folder
    mockInvoke.mockResolvedValueOnce(undefined); // save_last_folder
    mockInvoke.mockResolvedValueOnce([]); // load_expanded_state
    mockInvoke.mockResolvedValueOnce("Hello, world!"); // read_file

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("scan_folder", { path: "/test/project" });
    });

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("hello.txt"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("read_file", { relativePath: "hello.txt" });
    });

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "hello.txt", content: "Hello, world!" })
      );
    });
  });

  it("edits file content and tracks changes", async () => {
    const onFileOpen = createOnFileOpen();
    const contentMap = new Map<string, string>();
    contentMap.set("code.js", "const x = 2;");
    const getActiveContent = createGetActiveContent(contentMap);

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "code.js", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={getActiveContent} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("code.js"));

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "code.js", content: "const x = 2;" })
      );
    });

    expect(getActiveContent).toHaveBeenCalledWith("code.js");
  });

  it("saves file content to disk", async () => {
    const onFileOpen = createOnFileOpen();
    const contentMap = new Map<string, string>();
    contentMap.set("data.json", '{"key": "updated"}');
    const getActiveContent = createGetActiveContent(contentMap);

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "data.json", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce(undefined);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={getActiveContent} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("data.json"));

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("write_file", {
        relativePath: "data.json",
        content: '{"key": "updated"}',
      });
    });
  });

  it("renames file and refreshes tree", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "old.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("old.txt"));

    await waitFor(() => {
      expect(screen.getByText("Rename")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() => {
      expect(screen.getByText(/New name for/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new.txt" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("rename_path", {
        relativePath: "old.txt",
        newName: "new.txt",
      });
    });
  });

  it("creates new file in folder", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("New File...")).toBeDefined();
    });

    fireEvent.click(screen.getByText("New File..."));

    await waitFor(() => {
      expect(screen.getByText(/File name/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "main.js" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_file", {
        parentRelativePath: "src",
        fileName: "main.js",
      });
    });
  });

  it("creates new folder", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(document.querySelector(".tree-content") as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("New Folder...")).toBeDefined();
    });

    fireEvent.click(screen.getByText("New Folder..."));

    await waitFor(() => {
      expect(screen.getByText(/Folder name/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "tests" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_folder", {
        parentRelativePath: "/test/project",
        folderName: "tests",
      });
    });
  });

  it("deletes file with confirmation", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "delete_me.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce(undefined);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("delete_me.txt"));

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockAsk).toHaveBeenCalledWith(
        'Delete "delete_me.txt"?',
        { title: "Confirm Delete", kind: "warning" }
      );
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_path", { relativePath: "delete_me.txt" });
    });
  });

  it("copies file with .copy suffix", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "original.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("original.txt"));

    await waitFor(() => {
      expect(screen.getByText("Copy")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("copy_file", { relativePath: "original.txt" });
    });
  });

  it("handles file read error gracefully", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null); // load_last_folder
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "missing.txt", isDir: false }],
    }); // scan_folder
    mockInvoke.mockResolvedValueOnce(undefined); // save_last_folder
    mockInvoke.mockResolvedValueOnce([]); // load_expanded_state
    mockInvoke.mockRejectedValueOnce(new Error("File not found")); // read_file

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("missing.txt"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("read_file", { relativePath: "missing.txt" });
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed to read file/)).toBeDefined();
    });

    expect(onFileOpen).not.toHaveBeenCalled();
  });

  it("handles rename conflict error", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null); // load_last_folder
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    }); // scan_folder
    mockInvoke.mockResolvedValueOnce(undefined); // save_last_folder
    mockInvoke.mockResolvedValueOnce([]); // load_expanded_state
    mockInvoke.mockRejectedValueOnce(new Error()); // rename_path fails
    mockInvoke.mockResolvedValueOnce({ name: "project", children: [{ name: "file.txt", isDir: false }] }); // scan_folder from refreshTree

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Rename")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() => {
      expect(screen.getByText(/New name for/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "existing.txt" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(screen.getByText(/Failed to rename/)).toBeDefined();
    });
  });

  it("preserves in-memory edits across file clicks", async () => {
    const onFileOpen = createOnFileOpen();
    const contentMap = new Map<string, string>();
    contentMap.set("file.txt", "edited content");
    const getActiveContent = createGetActiveContent(contentMap);

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={getActiveContent} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ content: "edited content" })
      );
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
  });

  it("handles nested folder navigation", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [
        {
          name: "src",
          isDir: true,
          children: [
            {
              name: "components",
              isDir: true,
              children: [{ name: "App.tsx", isDir: false }],
            },
          ],
        },
      ],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("components")).toBeDefined();
    });

    fireEvent.click(screen.getByText("components"));

    await waitFor(() => {
      expect(screen.getByText("App.tsx")).toBeDefined();
    });

    fireEvent.click(screen.getByText("App.tsx"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("read_file", {
        relativePath: "src/components/App.tsx",
      });
    });
  });

  it("loads expanded state on folder open", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce("/last/path");
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });
    mockInvoke.mockResolvedValueOnce(["src"]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("load_expanded_state", { rootPath: "/last/path" });
    });

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });
  });

  it("saves expanded state on folder toggle", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "src", isDir: true, children: [] }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_expanded_state", expect.anything());
    });
  });

  it("handles delete cancellation", async () => {
    const onFileOpen = createOnFileOpen();
    mockAsk.mockResolvedValue(false);

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "file.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("file.txt"));

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockAsk).toHaveBeenCalled();
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("delete_path", expect.anything());
  });

  it("full workflow: open, edit, save", async () => {
    const onFileOpen = createOnFileOpen();
    const contentMap = new Map<string, string>();
    contentMap.set("script.py", "print('hello')");

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "script.py", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(
      <FileTree
        onFileOpen={onFileOpen}
        getActiveContent={(path) => {
          if (path === "script.py") return contentMap.get(path);
          return undefined;
        }}
      />
    );

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("script.py"));

    await waitFor(() => {
      expect(onFileOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "script.py", content: "print('hello')" })
      );
    });

    contentMap.set("script.py", "print('world')");

    fireEvent.contextMenu(screen.getByText("script.py"));

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("write_file", {
        relativePath: "script.py",
        content: "print('world')",
      });
    });
  });

  it("full workflow: create file, edit, save", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(document.querySelector(".tree-content") as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("New File...")).toBeDefined();
    });

    fireEvent.click(screen.getByText("New File..."));

    await waitFor(() => {
      expect(screen.getByText(/File name/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new_file.txt" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_file", {
        parentRelativePath: "/test/project",
        fileName: "new_file.txt",
      });
    });
  });

  it("full workflow: rename, then read renamed file", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "old_name.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("old_name.txt"));

    await waitFor(() => {
      expect(screen.getByText("Rename")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() => {
      expect(screen.getByText(/New name for/)).toBeDefined();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new_name.txt" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("rename_path", {
        relativePath: "old_name.txt",
        newName: "new_name.txt",
      });
    });

    expect(mockInvoke).toHaveBeenCalledWith("scan_folder", expect.anything());
  });

  it("full workflow: copy, then read both files", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [{ name: "original.txt", isDir: false }],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText("original.txt"));

    await waitFor(() => {
      expect(screen.getByText("Copy")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("copy_file", { relativePath: "original.txt" });
    });

    expect(mockInvoke).toHaveBeenCalledWith("scan_folder", expect.anything());
  });

  it("full workflow: delete folder and all contents", async () => {
    const onFileOpen = createOnFileOpen();

    mockInvoke.mockResolvedValueOnce(null);
    mockInvoke.mockResolvedValueOnce({
      name: "project",
      children: [
        {
          name: "to_delete",
          isDir: true,
          children: [{ name: "file.txt", isDir: false }],
        },
      ],
    });
    mockInvoke.mockResolvedValueOnce([]);

    renderWithToast(<FileTree onFileOpen={onFileOpen} getActiveContent={createGetActiveContent()} />);

    fireEvent.click(screen.getByText("Open Folder"));

    await waitFor(() => {
      expect(document.querySelector(".tree-content")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("to_delete"));

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeDefined();
    });

    fireEvent.contextMenu(screen.getByText("to_delete"));

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockAsk).toHaveBeenCalledWith(
        'Delete "to_delete" and all its contents?',
        { title: "Confirm Delete", kind: "warning" }
      );
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_path", { relativePath: "to_delete" });
    });
  });
});
