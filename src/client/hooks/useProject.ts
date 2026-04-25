import { useCallback, useState } from 'react';
import { api } from '../api';

export function useProject() {
  const [projectPath, setProjectPath] = useState<string>('');

  const refreshProject = useCallback(async () => {
    try {
      const res = await api.getProject();
      setProjectPath(res.path);
    } catch {
      setProjectPath('');
    }
  }, []);

  const openProject = useCallback(async (path: string) => {
    const res = await api.openProject(path);
    setProjectPath(res.path);
    return res.path;
  }, []);

  return {
    projectPath,
    refreshProject,
    openProject,
  };
}
