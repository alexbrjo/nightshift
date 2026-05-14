interface DataSourceSelectProps {
  id: string;
  value: string;
  error?: string;
  dataFiles: string[];
  onChange: (value: string) => void;
  onBrowse: () => void;
}

export default function DataSourceSelect({
  id,
  value,
  error,
  dataFiles,
  onChange,
  onBrowse,
}: DataSourceSelectProps) {
  if (dataFiles.length > 0) {
    return (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={error ? "error" : ""}
      >
        <option value="">Select a data source...</option>
        {dataFiles.length > 0 && (
          <optgroup label="Files">
            {dataFiles.map((file) => (
              <option key={`f:${file}`} value={file}>{file}</option>
            ))}
          </optgroup>
        )}
      </select>
    );
  }

  return (
    <div className="file-picker-row">
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="path/to/data.jsonl"
        className={error ? "error" : ""}
      />
      <button type="button" className="btn-secondary" onClick={onBrowse}>
        Browse
      </button>
    </div>
  );
}
