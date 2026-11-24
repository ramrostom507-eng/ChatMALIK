import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const svg = await (await import('node:fs/promises')).readFile(new URL('../icons/icon.svg', import.meta.url));
const androidRes = new URL('../android/app/src/main/res/', import.meta.url);

const densities = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192]
];

for (const [density, size] of densities) {
  const dir = new URL(`mipmap-${density}/`, androidRes);
  await mkdir(dir, { recursive: true });
  const png = await sharp(svg).resize(size, size).png().toBuffer();
  await writeFile(new URL('ic_launcher.png', dir), png);
  await writeFile(new URL('ic_launcher_round.png', dir), png);
}

// Android 8+ adaptive launcher icon: Android applies the device's own mask.
const foregroundDir = new URL('mipmap-xxxhdpi/', androidRes);
const foregroundSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect x="76" y="76" width="360" height="360" rx="88" fill="#2465A8"/>
<path d="M130 354V158h54l72 94 72-94h54v196h-58V245l-68 84-68-84v109z" fill="#F1F7FF"/>
<circle cx="256" cy="112" r="16" fill="#8CC8FF"/>
</svg>`);
const adaptivePng = await sharp(foregroundSvg).resize(432, 432).png().toBuffer();
await writeFile(new URL('chatmalik_foreground.png', foregroundDir), adaptivePng);

const v26 = new URL('mipmap-anydpi-v26/', androidRes);
await mkdir(v26, { recursive: true });
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/chatmalik_launcher_background"/>
    <foreground android:drawable="@mipmap/chatmalik_foreground"/>
</adaptive-icon>`;
await writeFile(new URL('ic_launcher.xml', v26), adaptive);
await writeFile(new URL('ic_launcher_round.xml', v26), adaptive);

const values = new URL('values/', androidRes);
await mkdir(values, { recursive: true });
await writeFile(new URL('chatmalik_launcher_colors.xml', values), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="chatmalik_launcher_background">#061A35</color>
</resources>`);
console.log('Generated ChatMALIK dark-blue Android launcher icons for all densities and adaptive icons.');
