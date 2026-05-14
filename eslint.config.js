import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["src/setupTests.ts"],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
      react,
      "react-hooks": reactHooks,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "complexity": ["error", { max: 20 }],
      "max-depth": ["error", 4],
      "max-lines-per-function": [
        "error",
        {
          max: 180,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "react/prop-types": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
      "src/**/__tests__/**/*.ts",
      "src/**/__tests__/**/*.tsx",
    ],
    rules: {
      "complexity": "off",
      "max-depth": "off",
      "max-lines-per-function": "off",
    },
  },
  {
    files: ["src/features/agent/AgentWorkspace.tsx"],
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 614, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/features/jobs/InferenceJobForm.tsx"],
    rules: {
      "complexity": ["error", { max: 42 }],
      "max-lines-per-function": [
        "error",
        { max: 625, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/features/jobs/JobViewPage.tsx"],
    rules: {
      "complexity": ["error", { max: 34 }],
      "max-lines-per-function": [
        "error",
        { max: 334, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/features/project-editor/Editor.tsx"],
    rules: {
      "complexity": ["error", { max: 28 }],
    },
  },
  {
    files: ["src/features/project-tree/FileTree.tsx"],
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 371, skipBlankLines: true, skipComments: true },
      ],
    },
  },
];
