import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

type ModePromptMap = Record<string, string>;

interface ModeConfigFile {
  prompts?: ModePromptMap;
}

const modeDirectoryPath = join(import.meta.dir, '../../../plugin/modes');
const disallowedPromptTextPatterns = [
  /You are a Claude-Mem/i,
  /primary Claude session/i,
  /Claude's Full Response to User:/i,
  /Claude's Full Investigation Response:/i,
  /DIFFERENT claude code session/i
];

function readModePromptFiles(): Array<{ fileName: string; prompts: ModePromptMap }> {
  const modeFileNames = readdirSync(modeDirectoryPath).filter((fileName) => fileName.endsWith('.json'));

  return modeFileNames.map((fileName) => {
    const modeFilePath = join(modeDirectoryPath, fileName);
    const modeFileContents = readFileSync(modeFilePath, 'utf-8');
    const parsedMode = JSON.parse(modeFileContents) as ModeConfigFile;
    return {
      fileName,
      prompts: parsedMode.prompts ?? {}
    };
  });
}

describe('mode prompt branding', () => {
  it('does not include legacy Claude branding in prompt strings', () => {
    const modePromptFiles = readModePromptFiles();
    const violations: string[] = [];

    for (const modePromptFile of modePromptFiles) {
      for (const [promptKey, promptValue] of Object.entries(modePromptFile.prompts)) {
        for (const disallowedPattern of disallowedPromptTextPatterns) {
          if (disallowedPattern.test(promptValue)) {
            violations.push(`${modePromptFile.fileName}#prompts.${promptKey} matched ${disallowedPattern}`);
            break;
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
