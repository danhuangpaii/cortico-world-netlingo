/** 打包 WebUI 面板:src/webui/client.ts → dist/webui.js。开发期脚本,产物随包提交。 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

mkdirSync(join(root, 'dist'), { recursive: true });
const result = await build({
  entryPoints: [join(root, 'src', 'webui', 'client.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(root, 'dist', 'webui.js'),
  logLevel: 'info',
});
console.log('built', result.outputFiles?.map((f) => f.path).join(', ') ?? 'dist/webui.js');
