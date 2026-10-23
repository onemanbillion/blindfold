// Copy the self-hosted Geist fonts (Latin subsets) into public/fonts.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
mkdirSync('public/fonts', { recursive: true });
for (const [pkg, file] of [
  ['@fontsource-variable/geist', 'geist-latin-wght-normal.woff2'],
  ['@fontsource-variable/geist-mono', 'geist-mono-latin-wght-normal.woff2'],
]) {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  copyFileSync(join(dir, 'files', file), join('public/fonts', file));
}
