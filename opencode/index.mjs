// OpenCode v2 adapter: registers the open-cu skill and its MCP server.
// The server itself is the same bundled CLI every other client runs.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default {
  id: 'open-cu',
  async setup(ctx) {
    const path = resolve(root, 'skills/open-cu/SKILL.md');
    const skill = await readFile(path, 'utf8');
    const description = skill.match(/^description: (.+)$/m)?.[1];
    if (!description) throw new Error('The open-cu skill description is missing.');
    await ctx.skill.transform((editor) =>
      editor.add({
        id: 'open-cu',
        name: 'open-cu',
        description,
        path,
        content: skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''),
      }),
    );
    await ctx.mcp.transform((editor) => {
      // Keep a server the user configured themselves.
      if (!editor.get('open-cu')) {
        editor.set('open-cu', {
          type: 'local',
          command: ['node', resolve(root, 'dist/cli.mjs'), 'mcp'],
          protocol: 'auto',
        });
      }
    });
  },
};
