import type { FileTab } from "../types";

interface FileTabsProps {
  tabs: FileTab[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
}

export default function FileTabs({ tabs, activeIndex, onSelect, onClose }: FileTabsProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="file-tabs">
      {tabs.map((tab, i) => (
        <button
          key={i}
          className={`file-tab ${i === activeIndex ? "active" : ""}`}
          onClick={() => onSelect(i)}
        >
          <span className="tab-name">{tab.name}</span>
          {tab.modified && <span className="modified-dot" />}
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(i);
            }}
          >
            &times;
          </button>
        </button>
      ))}
    </div>
  );
}
