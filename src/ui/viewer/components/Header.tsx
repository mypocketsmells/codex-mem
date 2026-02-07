import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';
import type { ProjectDiagnostics } from '../types';

interface HeaderProps {
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  isProcessing: boolean;
  queueDepth: number;
  oldestPendingAgeMs: number | null;
  activeProviders: string[];
  projectDiagnostics: ProjectDiagnostics | null;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
}

export function Header({
  isConnected,
  projects,
  currentFilter,
  onFilterChange,
  isProcessing,
  queueDepth,
  oldestPendingAgeMs,
  activeProviders,
  projectDiagnostics,
  themePreference,
  onThemeChange,
  onContextPreviewToggle
}: HeaderProps) {
  useSpinningFavicon(isProcessing);

  const oldestPendingSeconds = typeof oldestPendingAgeMs === 'number'
    ? Math.floor(oldestPendingAgeMs / 1000)
    : null;
  const showSlowProcessingHint = isProcessing && queueDepth > 0 && oldestPendingSeconds !== null && oldestPendingSeconds >= 15;
  const providerLabel = activeProviders.length > 0 ? activeProviders.join(', ') : 'active provider';
  const missingProjectCount = projectDiagnostics?.missingCount || 0;
  const showMissingProjectsHint = missingProjectCount > 0;

  return (
    <div className="header">
      <h1>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <img src="claude-mem-logomark.webp" alt="" className={`logomark ${isProcessing ? 'spinning' : ''}`} />
          {queueDepth > 0 && (
            <div className="queue-bubble">
              {queueDepth}
            </div>
          )}
        </div>
        <span className="logo-text">codex-mem</span>
      </h1>
      <div className="status">
        {showSlowProcessingHint && (
          <div className="processing-hint" title="Queue has been active for a while. Open Console for detailed retries and provider logs.">
            {`Processing ${providerLabel} for ${oldestPendingSeconds}s`}
          </div>
        )}
        {showMissingProjectsHint && (
          <div
            className="processing-hint"
            title={`Found ${missingProjectCount} Codex project(s) in session transcripts that are not ingested yet`}
          >
            {`${missingProjectCount} project${missingProjectCount === 1 ? '' : 's'} discovered, not yet ingested`}
          </div>
        )}
        <select
          value={currentFilter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map(project => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
        <ThemeToggle
          preference={themePreference}
          onThemeChange={onThemeChange}
        />
        <button
          className="settings-btn"
          onClick={onContextPreviewToggle}
          title="Settings"
        >
          <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>
    </div>
  );
}
