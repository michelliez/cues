import type { SupabaseClient } from "@supabase/supabase-js";
import {
  E164,
  type SendOutcome,
  type SpectrumConfig,
  sendSpectrumMessage,
} from "./spectrum-send.ts";

/**
 * The hosted twin of agent/notification_activation.py: read the signed-in teacher's saved phone
 * and current consent, send one test through Spectrum, and record the result with the existing
 * guarded RPC. The destination always comes from the database for the verified user; the browser
 * supplies neither a phone nor an id. There is no static-phone fallback here.
 */
export const TEST_MESSAGE = "Cues notifications are connected.";

type Sender = (
  config: SpectrumConfig,
  destination: string,
  message: string,
) => Promise<SendOutcome>;

export type TestSendResult = { status: "registered" | "pending" };

export async function sendTeacherTestNotification(
  admin: SupabaseClient,
  userId: string,
  config: SpectrumConfig,
  send: Sender = sendSpectrumMessage,
): Promise<TestSendResult> {
  if (!config.projectId || !config.projectSecret)
    throw new Error("Notification configuration unavailable");
  const [profile, settings] = await Promise.all([
    admin.from("teacher_profiles").select("phone_number").eq("user_id", userId),
    admin
      .from("teacher_notification_settings")
      .select("notification_opt_in,notification_phone,photon_project_id,registration_attempt")
      .eq("user_id", userId),
  ]);
  if (profile.error || settings.error) throw new Error("Notification state unavailable");
  const phone = (profile.data?.[0] as { phone_number?: unknown } | undefined)?.phone_number;
  const state = (settings.data?.[0] ?? {}) as {
    notification_opt_in?: unknown;
    notification_phone?: unknown;
    photon_project_id?: unknown;
    registration_attempt?: unknown;
  };
  // Explicit consent, a valid saved phone that still matches the consent, and this Photon project.
  if (
    state.notification_opt_in !== true ||
    typeof phone !== "string" ||
    !E164.test(phone) ||
    state.notification_phone !== phone ||
    state.photon_project_id !== config.projectId ||
    !state.registration_attempt
  )
    throw new Error("Teacher notification consent unavailable");

  let outcome: "accepted" | "target_not_allowed" | "provider_failure" | "network_failure";
  try {
    const sent = await send(config, phone, TEST_MESSAGE);
    outcome = sent.accepted ? "accepted" : sent.category;
  } catch {
    outcome = "provider_failure";
  }
  // Record every result, success or not, so consent state and the send agree.
  const { data, error } = await admin.rpc("record_teacher_notification_send", {
    p_user_id: userId,
    p_phone: phone,
    p_attempt: state.registration_attempt,
    p_project_id: config.projectId,
    p_result: outcome,
  });
  if (error || data !== true) throw new Error("Notification consent changed; send result not applied");
  if (outcome === "accepted") return { status: "registered" };
  // Not on the Photon project's allowlist yet: stays "activating" until the website step is done.
  if (outcome === "target_not_allowed") return { status: "pending" };
  throw new Error(`Notification send failed: ${outcome}`);
}
