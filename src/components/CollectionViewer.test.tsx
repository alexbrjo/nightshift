import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import CollectionViewer from "./CollectionViewer";

// Mock the invoke function
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("CollectionViewer", () => {
  const mockCollectionId = 1;
  const mockItems = [
    {
      id: 1,
      collection_id: mockCollectionId,
      data: { name: "Alice", age: 30, email: "alice@example.com" },
      created_at: "2024-01-01T00:00:00Z",
    },
    {
      id: 2,
      collection_id: mockCollectionId,
      data: { name: "Bob", age: 25, email: "bob@example.com" },
      created_at: "2024-01-02T00:00:00Z",
    },
    {
      id: 3,
      collection_id: mockCollectionId,
      data: { name: "Charlie", age: 35, email: "charlie@example.com" },
      created_at: "2024-01-03T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially", () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    
    render(<CollectionViewer collectionId={mockCollectionId} />);
    
    expect(screen.getByText(/Loading collection/i)).toBeInTheDocument();
  });

  it("fetches and displays collection items on mount", async () => {
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockItems) // get_collection_items
      .mockResolvedValueOnce(mockItems.length); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Collection #1")).toBeInTheDocument();
    });

    // Check that items are displayed
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();

    // Check column headers
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("age")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("displays empty state when no items", async () => {
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // get_collection_items
      .mockResolvedValueOnce(0); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText(/No items in this collection/i)).toBeInTheDocument();
    });
  });

  it("handles delete item confirmation", async () => {
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockItems) // get_collection_items
      .mockResolvedValueOnce(mockItems.length); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // Mock delete success
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    // Find and click delete button for first item
    const deleteButtons = screen.getAllByTitle("Delete item");
    fireEvent.click(deleteButtons[0]);

    // Confirm dialog would be shown (in real scenario)
    expect(invoke).toHaveBeenCalledWith("delete_collection_item", { itemId: 1 });
  });

  it("handles export JSONL", async () => {
    const mockJsonlContent = '{"id":1,"data":{"name":"Alice"}}\n{"id":2,"data":{"name":"Bob"}}';
    
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockItems) // get_collection_items
      .mockResolvedValueOnce(mockItems.length); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Export JSONL")).toBeInTheDocument();
    });

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockJsonlContent);

    const exportJsonlButton = screen.getByText(/📥 Export JSONL/i);
    fireEvent.click(exportJsonlButton);

    expect(invoke).toHaveBeenCalledWith("export_collection_jsonl", { collectionId: mockCollectionId });
  });

  it("handles export CSV", async () => {
    const mockCsvContent = "id,name,age,email\n1,Alice,30,alice@example.com";
    
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockItems) // get_collection_items
      .mockResolvedValueOnce(mockItems.length); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Export CSV")).toBeInTheDocument();
    });

    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockCsvContent);

    const exportCsvButton = screen.getByText(/📥 Export CSV/i);
    fireEvent.click(exportCsvButton);

    expect(invoke).toHaveBeenCalledWith("export_collection_csv", { collectionId: mockCollectionId });
  });

  it("handles search filter", async () => {
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockItems) // get_collection_items
      .mockResolvedValueOnce(mockItems.length); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // All items should be visible initially
    expect(screen.getAllByRole("row").length).toBeGreaterThan(3);

    // Search for "Bob"
    const searchInput = screen.getByPlaceholderText(/Search items/i);
    fireEvent.change(searchInput, { target: { value: "Bob" } });

    // Only Bob should be visible (client-side filtering)
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("handles pagination", async () => {
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      collection_id: mockCollectionId,
      data: { name: `User${i + 1}`, value: i },
      created_at: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));

    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(manyItems.slice(0, 25)) // get_collection_items page 1
      .mockResolvedValueOnce(30); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText(/Page 1 of/i)).toBeInTheDocument();
    });

    // Should show pagination controls
    expect(screen.getByText("Previous")).toBeInTheDocument();
    expect(screen.getByText("Next →")).toBeInTheDocument();

    // Previous should be disabled on page 1
    const prevButton = screen.getByText("Previous");
    expect(prevButton).toBeDisabled();

    // Next should be enabled
    const nextButton = screen.getByText("Next →");
    expect(nextButton).not.toBeDisabled();
  });

  it("calls onBack when back button is clicked", async () => {
    const mockOnBack = vi.fn();
    
    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // get_collection_items
      .mockResolvedValueOnce(0); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} onBack={mockOnBack} />);

    await waitFor(() => {
      expect(screen.getByText("← Back")).toBeInTheDocument();
    });

    const backButton = screen.getByText("← Back");
    fireEvent.click(backButton);

    expect(mockOnBack).toHaveBeenCalledTimes(1);
  });

  it("displays error message when fetch fails", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Database error"));

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText(/Database error/i)).toBeInTheDocument();
    });
  });

  it("handles items with nested objects", async () => {
    const itemsWithNested = [
      {
        id: 1,
        collection_id: mockCollectionId,
        data: { 
          name: "Test", 
          metadata: { key: "value", nested: { deep: true } },
          tags: ["a", "b", "c"]
        },
        created_at: "2024-01-01T00:00:00Z",
      },
    ];

    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(itemsWithNested) // get_collection_items
      .mockResolvedValueOnce(1); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Test")).toBeInTheDocument();
    });

    // Nested objects should be JSON stringified
    expect(screen.getByText(/"key":"value"/)).toBeInTheDocument();
  });

  it("handles items with missing fields gracefully", async () => {
    const itemsWithMissingFields = [
      {
        id: 1,
        collection_id: mockCollectionId,
        data: { name: "Alice", age: 30 },
        created_at: "2024-01-01T00:00:00Z",
      },
      {
        id: 2,
        collection_id: mockCollectionId,
        data: { name: "Bob" }, // missing age
        created_at: "2024-01-02T00:00:00Z",
      },
    ];

    (invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(itemsWithMissingFields) // get_collection_items
      .mockResolvedValueOnce(2); // get_collection_count

    render(<CollectionViewer collectionId={mockCollectionId} />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // Both items should display, with empty cell for missing age in Bob's row
    expect(screen.getAllByText("Bob").length).toBeGreaterThan(0);
  });
});
