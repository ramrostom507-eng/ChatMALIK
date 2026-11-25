import { createClient } from '@supabase/supabase-js';

// Expose the same global API expected by the existing ChatMALIK page.
window.supabase = { createClient };
