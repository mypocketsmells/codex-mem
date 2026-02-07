import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

function extractZIndex(cssSource: string, className: string): number | null {
  const blockPattern = new RegExp(`\\.${className}\\s*\\{[^}]*\\}`, 'm');
  const blockMatch = cssSource.match(blockPattern);
  if (!blockMatch) {
    return null;
  }

  const zIndexPattern = /z-index:\s*(\d+)/;
  const zIndexMatch = blockMatch[0].match(zIndexPattern);
  if (!zIndexMatch) {
    return null;
  }

  return Number(zIndexMatch[1]);
}

describe('viewer console layering', () => {
  it('keeps the toggle button above the console drawer so it can close reliably', () => {
    const viewerTemplatePath = path.resolve(
      process.cwd(),
      'src/ui/viewer-template.html'
    );
    const viewerTemplateSource = readFileSync(viewerTemplatePath, 'utf8');

    const toggleButtonZIndex = extractZIndex(viewerTemplateSource, 'console-toggle-btn');
    const drawerZIndex = extractZIndex(viewerTemplateSource, 'console-drawer');

    expect(toggleButtonZIndex).not.toBeNull();
    expect(drawerZIndex).not.toBeNull();
    expect(toggleButtonZIndex!).toBeGreaterThan(drawerZIndex!);
  });
});
