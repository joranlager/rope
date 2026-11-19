// Builds the static site into dist/ for GitHub Pages. There is no backend to configure.
import { cp, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
// Stops Pages from running Jekyll, which would hide files starting with an underscore.
await writeFile('dist/.nojekyll', '');
console.log('Built dist/');
