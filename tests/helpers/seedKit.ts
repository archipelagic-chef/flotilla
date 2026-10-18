import * as esbuild from 'esbuild';
import { seedKitOptions } from '../../scripts/seed-kit.mjs';

/** Builds the playground seed's kit before the tests run, as `npm run build` does (the seed imports it from dist/). */
export default async function setup(): Promise<void> {
  await esbuild.build({ ...seedKitOptions, logLevel: 'silent' });
}
