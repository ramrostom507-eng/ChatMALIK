import { cp, mkdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('../www/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ['index.html', 'manifest.webmanifest', 'icons']) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

console.log('ChatMALIK web app copied into www/ for the Android build.');
