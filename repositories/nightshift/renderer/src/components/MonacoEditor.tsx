import Editor from '@monaco-editor/react';

interface MonacoEditorProps {
  height?: string;
  language: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string | undefined) => void;
  theme?: string;
  options?: Record<string, unknown>;
  readOnly?: boolean;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({
  height = '300px',
  language,
  value,
  defaultValue = '',
  onChange,
  theme = 'vs-dark',
  options = {},
  readOnly = false,
}) => {
  return (
    <Editor
      height={height}
      language={language}
      value={value ?? defaultValue}
      defaultLanguage={language}
      theme={theme}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        automaticLayout: true,
        readOnly,
        ...options,
      }}
      onChange={onChange}
    />
  );
};

export default MonacoEditor;
