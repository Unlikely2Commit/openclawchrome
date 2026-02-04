import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const entryPoints = {
  background: path.join(root, 'src/background.ts'),
  content: path.join(root, 'src/content.ts'),
  popup: path.join(root, 'src/popup.ts')
};

await build({
  entryPoints,
  outdir: dist,
  bundle: true,
  format: 'esm',
  sourcemap: true,
  target: ['chrome120'],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
});

// copy static
fs.cpSync(path.join(root, 'static'), dist, { recursive: true });

console.log('Extension build complete:', dist);
