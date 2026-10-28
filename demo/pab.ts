// The benchmark's own modules (built into ../dist by `npm run build` at the repository root).
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const PAB_ROOT = path.resolve(import.meta.dirname, '..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pab = (module: string): any => require(path.join(PAB_ROOT, 'dist', 'src', module));
