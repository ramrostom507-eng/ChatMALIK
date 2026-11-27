import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Keep the existing ChatMALIK global API while explicitly preserving login
// sessions in the WebView's durable local storage across app updates.
function createClient(url, key, options = {}) {
  const suppliedAuth = options.auth || {};
  return createSupabaseClient(url, key, {
    ...options,
    auth: {
      ...suppliedAuth,
      storage: suppliedAuth.storage || window.localStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

window.supabase = { createClient };
