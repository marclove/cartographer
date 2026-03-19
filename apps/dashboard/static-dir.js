import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const staticDir = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  'dist',
  'client'
);
