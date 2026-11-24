# ChatMALIK V2 (preview)

This folder contains the isolated white-interface rebuild. The original root app remains untouched while this preview is tested.

## Current preview scope
- Supabase email/password sign-up, sign-in, password reset and session restoration
- Per-user conversation list and message history using existing RLS policies
- ChatMALIK Edge Function integration
- Image and text-file uploads to the private chatmalik-attachments bucket
- Browser speech recognition, speech synthesis, selectable voices exposed by the device/browser, and turn-based voice conversation
- Arabic, English, French, German, Spanish, Turkish, Italian, Portuguese, Russian, Chinese and Japanese interface labels

## Known staged limitations
- PDF and Office document extraction is not enabled in this preview; the current Edge Function accepts images and text files only.
- Browser voices are device/browser voices, not a hosted premium voice catalogue. A dedicated multilingual TTS provider and native Android voice QA are later milestones.
- Existing accounts and conversations are not deleted by this preview. New registrations start with empty histories because conversations are scoped by Supabase user ID.

The root production page is not changed by this preview.
