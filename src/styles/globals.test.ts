import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "globals.css");
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

describe("default theme tokens", () => {
  it("uses dumpster blue chrome and label action colors", () => {
    const root = cssBlock(":root");

    expect(root).toContain("--nav-bg: #404778");
    expect(root).toContain("--label-yellow: #edd926");
    expect(root).toContain("--label-red: #e0291f");
    expect(root).toContain("--label-ink: #342e06");
  });

  it("does not use the old orange lab theme in the default token block", () => {
    const root = cssBlock(":root");

    expect(root).not.toContain("#d36f05");
    expect(root).not.toContain("#ef9333");
    expect(root).not.toContain("239, 147, 51");
  });
});

describe("page surface shape rules", () => {
  it("keeps job creation surfaces square", () => {
    expect(css).toContain(".job-runner-page .empty-state,");
    expect(css).toContain(".job-runner-page fieldset,");
    expect(css).toContain(".job-runner-page .number-input button:last-child");
    expect(css).toContain("border-radius: 0;");
  });

  it("keeps the planning agent workspace square", () => {
    expect(css).toContain(".agent-workspace button,");
    expect(css).toContain(".agent-chat-input input,");
    expect(css).toContain(".method-flow-resource-node");
    expect(css).toContain("border-radius: 0;");
  });

  it("renders method graph input nodes as white uniform cards with wrapped file paths", () => {
    const resourceNode = cssBlock(".method-flow-resource-node");
    const resourceCode = cssBlock(".method-flow-resource-node code");

    expect(resourceNode).toContain("width: 300px;");
    expect(resourceNode).toContain("min-height: 90px;");
    expect(resourceNode).toContain("background: var(--bg-elevated);");
    expect(resourceCode).toContain("white-space: normal;");
    expect(resourceCode).toContain("overflow-wrap: anywhere;");
  });
});
