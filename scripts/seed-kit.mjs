// The build of the app's code that the playground seed uses (src/features/backlog/seedKit.ts), shared by esbuild.mjs
// (npm run build) and the unit test's setup, so both make the same file.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const seedKitOptions = {
  entryPoints: [path.join(root, 'src/features/backlog/seedKit.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(root, 'dist/playground-seed-kit.mjs'),
};
