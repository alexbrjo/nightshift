import FileExplorer from './FileExplorer';
import Editor from './Editor';

export default function ProjectView() {
  return (
    <div className="flex h-full">
      <FileExplorer />
      <div className="flex-1 min-w-0">
        <Editor />
      </div>
    </div>
  );
}
