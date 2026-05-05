import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import DefinitionForm from "./DefinitionForm";
import { ToastProvider } from "./Toast";

function renderForm(props: Partial<React.ComponentProps<typeof DefinitionForm>> = {}) {
  return render(
    <ToastProvider>
      <DefinitionForm
        defId={null}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

describe("DefinitionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve(["greet.jinja2"]);
      if (cmd === "list_data_files") return Promise.resolve(["data.jsonl"]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      return Promise.resolve();
    });
  });

  it("renders the New Experiment heading and a kind dropdown locked to inference", async () => {
    renderForm();
    expect(await screen.findByText("New Experiment")).toBeInTheDocument();
    const kind = screen.getByLabelText(/^Kind$/i) as HTMLSelectElement;
    expect(kind.value).toBe("inference");
    expect(kind).toBeDisabled();
  });

  it("submits a new definition via definition_create + definition_save_version", async () => {
    const onSaved = vi.fn();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_prompt_files") return Promise.resolve(["greet.jinja2"]);
      if (cmd === "list_data_files") return Promise.resolve(["data.jsonl"]);
      if (cmd === "list_schema_files") return Promise.resolve([]);
      if (cmd === "definition_create") return Promise.resolve(42);
      if (cmd === "definition_save_version") return Promise.resolve(101);
      return Promise.resolve();
    });
    renderForm({ onSaved });

    // Wait for file lists to load.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("list_prompt_files"));

    fireEvent.change(screen.getByLabelText(/Name \*/i), { target: { value: "my-exp" } });
    fireEvent.change(screen.getByLabelText(/Prompt Spec \*/i), {
      target: { value: "greet.jinja2" },
    });
    fireEvent.change(screen.getByLabelText(/Data Source \*/i), {
      target: { value: "data.jsonl" },
    });
    fireEvent.change(screen.getByLabelText(/Model \*/i), { target: { value: "gpt-4" } });

    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(42));
    expect(mockInvoke).toHaveBeenCalledWith("definition_create", {
      input: { parentId: null, name: "my-exp", position: 0 },
    });
    const saveCall = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "definition_save_version");
    expect(saveCall).toBeDefined();
    expect(saveCall![1]).toMatchObject({
      input: {
        defId: 42,
        content: { kind: "inference", inputRef: { kind: "file", path: "data.jsonl" } },
      },
    });
  });

  it("renders inline field errors when required fields are empty", async () => {
    renderForm();
    await screen.findByText("New Experiment");
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    expect(await screen.findByText(/Name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/Prompt file is required/i)).toBeInTheDocument();
    expect(screen.getByText(/Data source is required/i)).toBeInTheDocument();
  });

  it("loads an existing definition's content when defId is supplied", async () => {
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

    expect(await screen.findByText("Edit Experiment")).toBeInTheDocument();
    expect((screen.getByLabelText(/Name \*/i) as HTMLInputElement).value).toBe("loaded");
    expect((screen.getByLabelText(/Model \*/i) as HTMLInputElement).value).toBe("gpt-4o");
    expect((screen.getByLabelText(/Data Source \*/i) as HTMLSelectElement | HTMLInputElement).value).toBe(
      "rows.jsonl",
    );
  });
});
