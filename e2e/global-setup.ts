import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

export default function globalSetup() {
  if (!existsSync('fixtures/moyenne-6mpx.tif') || !existsSync('public/samples/positif.jpg')) {
    execSync('npm run fixtures', { stdio: 'inherit' });
  }
}
