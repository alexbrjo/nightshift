import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import JobPanel from './components/JobPanel';
import JobStatus from './components/JobStatus';
import CollectionsList from './components/CollectionsList';
import CollectionView from './components/CollectionView';
import ActionPanel from './components/ActionPanel';
import PipelineEditor from './components/PipelineEditor';
import AgentPanel from './components/AgentPanel';
import ProjectView from './components/ProjectView';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<ProjectView />} />
        <Route path="jobs" element={<JobPanel />} />
        <Route path="jobs/:id" element={<JobStatus />} />
        <Route path="collections" element={<CollectionsList />} />
        <Route path="collections/:name" element={<CollectionView />} />
        <Route path="actions" element={<ActionPanel />} />
        <Route path="pipelines" element={<PipelineEditor />} />
        <Route path="agents" element={<AgentPanel />} />
        <Route path="*" element={<div className="p-4">Not Found</div>} />
      </Route>
    </Routes>
  );
}
