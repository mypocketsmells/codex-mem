import { useCallback, useEffect, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { ProjectDiagnostics } from '../types';

const REFRESH_INTERVAL_MS = 15000;

export function useProjectDiagnostics() {
  const [projectDiagnostics, setProjectDiagnostics] = useState<ProjectDiagnostics | null>(null);

  const loadProjectDiagnostics = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.PROJECT_DIAGNOSTICS);
      if (!response.ok) {
        throw new Error(`Failed to fetch project diagnostics: ${response.status}`);
      }
      const diagnostics = await response.json() as ProjectDiagnostics;
      setProjectDiagnostics(diagnostics);
    } catch (error) {
      console.error('Failed to load project diagnostics:', error);
    }
  }, []);

  useEffect(() => {
    loadProjectDiagnostics();
    const timer = setInterval(loadProjectDiagnostics, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadProjectDiagnostics]);

  return {
    projectDiagnostics,
    refreshProjectDiagnostics: loadProjectDiagnostics
  };
}
