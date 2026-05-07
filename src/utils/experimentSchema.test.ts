import { describe, it, expect } from "vitest";
import { parsePlannerTurn, PLANNER_TURN_SCHEMA } from "./experimentSchema";

describe("parsePlannerTurn", () => {
  it("parses a question turn", () => {
    const t = parsePlannerTurn(
      JSON.stringify({
        kind: "question",
        header: "IV name",
        question: "Which variable do you want to vary?",
        options: [
          { label: "model", description: "Vary the LLM model" },
          { label: "temperature", description: "Vary sampling temp" },
        ],
        multiSelect: false,
        allowOther: false,
      }),
    );
    expect(t.kind).toBe("question");
  });

  it("strips ```json code fences", () => {
    const wrapped = "```json\n" + JSON.stringify({ kind: "freeform", header: "Hyp", prompt: "x" }) + "\n```";
    const t = parsePlannerTurn(wrapped);
    expect(t.kind).toBe("freeform");
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePlannerTurn("not json")).toThrow(/valid JSON/);
  });

  it("rejects unknown kind", () => {
    expect(() => parsePlannerTurn(JSON.stringify({ kind: "garbage" }))).toThrow(/unknown kind/);
  });

  it("exports a JSON Schema with three branches", () => {
    expect(PLANNER_TURN_SCHEMA.oneOf).toHaveLength(3);
  });
});
