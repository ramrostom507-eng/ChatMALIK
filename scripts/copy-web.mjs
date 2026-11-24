import { cp, mkdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('../www/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ['index.html', 'manifest.webmanifest', 'icons']) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

const indexUrl = new URL('index.html', output);
const { readFile, writeFile } = await import('node:fs/promises');
let html = await readFile(indexUrl, 'utf8');
html = html.replace('</head>', '  <script src="./native-voice.js"></script>\n</head>');
await writeFile(indexUrl, html);
console.log('ChatMALIK web app and native voice bridge copied into www/ for the Android build.');
