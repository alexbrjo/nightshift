import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import DefinitionForm from "./DefinitionForm";
import { ToastProvider } from "./Toast";

function renderForm(props: Partial<React.ComponentProps<typeof DefinitionForm>> = {}) {
  return render(
    <ToastProvider>
      <DefinitionForm
        defId={1}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

function unsavedDefinition(parentId: number | null) {
  return {
    definition: {
      id: 1,
      parentId,
      rootId: parentId ?? 1,
      name: "fresh",
      position: 0,
      currentVersionId: null,
      source: "user",
      deletedAt: null,
      createdAt: "",
      updatedAt: "",
      currentKind: null,
    },
    version: null,
  };
}

describe("DefinitionForm (node editor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults a new ROOT definition to kind=group", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve([]);
      if (cmd === "list_data_files") return Promise.resolve([]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      if (cmd === "definition_read_current") return Promise.resolve(unsavedDefinition(null));
      if (cmd === "definition_list_versions") return Promise.resolve([]);
      return Promise.resolve();
    });
    renderForm();
    expect(await screen.findByText(/New root \(group\)/)).toBeInTheDocument();
    const kind = screen.getByLabelText(/^Kind$/i) as HTMLSelectElement;
    expect(kind.value).toBe("group");
  });

  it("defaults a new CHILD definition to kind=inference", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve([]);
      if (cmd === "list_data_files") return Promise.resolve([]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      if (cmd === "definition_read_current") return Promise.resolve(unsavedDefinition(99));
      if (cmd === "definition_list_versions") return Promise.resolve([]);
      return Promise.resolve();
    });
    renderForm();
    expect(await screen.findByText(/New child \(inference\)/)).toBeInTheDocument();
    const kind = screen.getByLabelText(/^Kind$/i) as HTMLSelectElement;
    expect(kind.value).toBe("inference");
  });

  it("submits an inference definition via definition_save_version (no Run button)", async () => {
    const onSaved = vi.fn();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve(["greet.jinja2"]);
      if (cmd === "list_data_files") return Promise.resolve(["data.jsonl"]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      if (cmd === "definition_read_current") return Promise.resolve(unsavedDefinition(99));
      if (cmd === "definition_list_versions") return Promise.resolve([]);
      if (cmd === "definition_save_version") return Promise.resolve(101);
      if (cmd === "definition_rename") return Promise.resolve();
      return Promise.resolve();
    });
    renderForm({ onSaved });

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("list_prompt_files"));

    fireEvent.change(screen.getByLabelText(/Name \*/i), { target: { value: "my-leaf" } });
    fireEvent.change(screen.getByLabelText(/Prompt Spec \*/i), {
      target: { value: "greet.jinja2" },
    });
    fireEvent.change(screen.getByLabelText(/Data Source \*/i), {
      target: { value: "data.jsonl" },
    });
    fireEvent.change(screen.getByLabelText(/Model \*/i), { target: { value: "gpt-4" } });

    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(1));
    const saveCall = mockInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === "definition_save_version",
    );
    expect(saveCall).toBeDefined();
    expect(saveCall![1]).toMatchObject({
      input: {
        defId: 1,
        content: { kind: "inference", inputRef: { kind: "file", path: "data.jsonl" } },
      },
    });
    // No Run button — execution lives on the Job Executions page.
    expect(screen.queryByRole("button", { name: /^Run$/ })).not.toBeInTheDocument();
  });

  it("renders a node-identity heading for a saved definition", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve([]);
      if (cmd === "list_data_files") return Promise.resolve([]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      if (cmd === "definition_read_current") {
        return Promise.resolve({
          definition: {
            id: 7,
            parentId: null,
            rootId: 7,
            name: "loaded",
            position: 0,
            currentVersionId: 99,
            source: "user",
            deletedAt: null,
            createdAt: "",
            updatedAt: "",
            currentKind: "inference",
          },
          version: {
            id: 99,
            definitionId: 7,
            parentVersionId: null,
            contentHash: "abc",
            kind: "inference",
            mode: null,
            params: JSON.stringify({
              prompt_file: "p.j2",
              provider: "OpenAI",
              model: "gpt-4o",
              server_url: "http://example.test",
              output_mode: "Plain JSON",
              samples: 5,
              strategy: "random",
            }),
            inputRef: JSON.stringify({ kind: "file", path: "rows.jsonl" }),
            description: null,
            message: null,
            createdBy: "user",
            triggeredByExecutionId: null,
            createdAt: "",
          },
        });
      }
      if (cmd === "definition_list_versions") return Promise.resolve([]);
      return Promise.resolve();
    });

    renderForm({ defId: 7 });

    expect(await screen.findByText(/loaded · inference/)).toBeInTheDocument();
    expect((screen.getByLabelText(/Name \*/i) as HTMLInputElement).value).toBe("loaded");
    expect((screen.getByLabelText(/Model \*/i) as HTMLInputElement).value).toBe("gpt-4o");
  });
});
