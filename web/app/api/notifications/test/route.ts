import "server-only";
import { createClient } from "@supabase/supabase-js";
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { testDemoNotification } from "@/lib/notification-test";
import { sendTeacherTestNotification } from "@/lib/notification-send";

// Hosted test send. Everything runs here in Node: no Python, no subprocess. Set these as server
// environment variables on the host (never NEXT_PUBLIC_*): SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL),
// SUPABASE_SERVICE_ROLE_KEY, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, and optionally
// SPECTRUM_SENDER_PHONE.
export async function POST(request: Request) {
  // Local development also reads the root and cues env files; a host's environment wins.
  const root = path.resolve(process.cwd(), process.cwd().endsWith(path.sep + "web") ? ".." : ".");
  const config: Record<string, string> = {};
  for (const file of [".env", "cues/.env"]) {
    try { Object.assign(config, parseEnv(readFileSync(path.join(root, file), "utf8"))); }
    catch { /* A deployment uses its process environment instead. */ }
  }
  for (const [key, value] of Object.entries(process.env)) if (value) config[key] = value;
  const url = config.SUPABASE_URL ?? config.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !config.SUPABASE_SERVICE_ROLE_KEY)
    return Response.json({error: "Notifications are not configured."}, {status: 503});
  const admin = createClient(url, config.SUPABASE_SERVICE_ROLE_KEY,
    {auth: {persistSession: false, autoRefreshToken: false}});
  return testDemoNotification(request, admin, userId =>
    sendTeacherTestNotification(admin, userId, {
      projectId: config.SPECTRUM_PROJECT_ID,
      projectSecret: config.SPECTRUM_PROJECT_SECRET,
      senderPhone: config.SPECTRUM_SENDER_PHONE || undefined,
    }));
}
