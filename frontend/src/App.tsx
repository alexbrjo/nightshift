import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './Layout.tsx'
import ProjectsPage from './pages/Projects.tsx'
import JobsPage from './pages/Jobs.tsx'
import CollectionsPage from './pages/Collections.tsx'
import PipelinesPage from './pages/Pipelines.tsx'
import AnalysesPage from './pages/Analyses.tsx'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ProjectsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<JobsPage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="collections" element={<CollectionsPage />} />
          <Route path="pipelines" element={<PipelinesPage />} />
          <Route path="analyses" element={<AnalysesPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
