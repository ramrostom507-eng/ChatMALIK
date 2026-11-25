import { readFile, writeFile } from 'node:fs/promises';

const manifestUrl = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url);
let xml = await readFile(manifestUrl, 'utf8');

const permissions = [
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO'
];

const applicationTag = '<application';
const ttsQueries = `<queries>
    <intent>
        <action android:name="android.intent.action.TTS_SERVICE" />
    </intent>
</queries>
    `;
if (!xml.includes('android.intent.action.TTS_SERVICE')) {
  xml = xml.replace(applicationTag, ttsQueries + applicationTag);
}

for (const permission of permissions) {
  if (!xml.includes(`android:name="${permission}"`)) {
    xml = xml.replace(
      '<application',
      `<uses-permission android:name="${permission}" />\n    <application`
    );
  }
}

const features = [
  'android.hardware.camera',
  'android.hardware.microphone'
];

for (const feature of features) {
  if (!xml.includes(`android:name="${feature}"`)) {
    xml = xml.replace(
      '<application',
      `<uses-feature android:name="${feature}" android:required="false" />\n    <application`
    );
  }
}

await writeFile(manifestUrl, xml);
console.log('Added optional camera and microphone permissions for ChatMALIK.');
