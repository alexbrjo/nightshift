import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionCard, FreeformCard } from "./PlannerCards";

describe("QuestionCard", () => {
  const baseTurn = {
    kind: "question" as const,
    header: "IV",
    question: "Which variable?",
    options: [
      { label: "model", description: "Vary LLM" },
      { label: "temperature", description: "Vary temp" },
    ],
    multiSelect: false,
    allowOther: false,
  };

  it("disables Confirm until an option is picked, then submits the label", () => {
    const onConfirm = vi.fn();
    render(<QuestionCard turn={baseTurn} onConfirm={onConfirm} disabled={false} />);
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/model/));
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("model");
  });

  it("multiSelect joins selected labels with commas", () => {
    const onConfirm = vi.fn();
    render(
      <QuestionCard
        turn={{ ...baseTurn, multiSelect: true }}
        onConfirm={onConfirm}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByLabelText(/model/));
    fireEvent.click(screen.getByLabelText(/temperature/));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("model, temperature");
  });

  it("allowOther reveals a textarea and includes typed text", () => {
    const onConfirm = vi.fn();
    render(
      <QuestionCard
        turn={{ ...baseTurn, allowOther: true }}
        onConfirm={onConfirm}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Other/i));
    fireEvent.change(screen.getByPlaceholderText(/Type a custom/i), {
      target: { value: "max_tokens" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("max_tokens");
  });
});

describe("FreeformCard", () => {
  it("submits the typed text", () => {
    const onConfirm = vi.fn();
    render(
      <FreeformCard
        turn={{ kind: "freeform", header: "Hyp", prompt: "Write a hypothesis", placeholder: "" }}
        onConfirm={onConfirm}
        disabled={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Bigger model wins" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onConfirm).toHaveBeenCalledWith("Bigger model wins");
  });
});
