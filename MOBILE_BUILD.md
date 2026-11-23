# ChatMALIK Android app

This repository keeps the existing ChatMALIK web application and packages the same interface and Supabase-backed services inside a native Android WebView using Capacitor.

## App identity
- Display name: ChatMALIK
- Android application ID: com.wowmarket.chatmalik
- Store destination: WOW MARKET

## Build
The GitHub Actions workflow `.github/workflows/android-debug.yml` builds a test APK when run manually or when relevant files are pushed to `main` or `mobile-android-build`.

The APK is uploaded as the workflow artifact `ChatMALIK-Android-debug`. It is for device testing, not the final store release.

## Store release requirements
Before publishing a public release, the project still needs:
- A release signing keystore owned and securely retained by the project owner.
- Signed Android App Bundle (AAB) or APK, according to WOW MARKET's upload requirements.
- Final launcher icon and screenshots.
- Privacy policy and store listing text.
- Device testing for login, chat, file upload, camera, microphone, and Android back navigation.

Do not commit signing keys, passwords, API secrets, or Supabase service-role keys to this repository.
