import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTeacherTestNotification, TEST_MESSAGE } from "../lib/notification-send.ts";
import { sendSpectrumMessage } from "../lib/spectrum-send.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551234567";
const PROJECT = "project-1";
const config = { projectId: PROJECT, projectSecret: "secret", senderPhone: undefined };
const consent = {
  notification_opt_in: true,
  notification_phone: PHONE,
  photon_project_id: PROJECT,
  registration_attempt: "attempt-1",
};

function database({ phone = PHONE as unknown, state = consent as object, recorded = true as unknown }) {
  const calls: { reads: string[]; rpc: unknown[] } = { reads: [], rpc: [] };
  const admin = {
    from(table: string) {
      return {
        select: () => ({
          eq: async (column: string, value: string) => {
            calls.reads.push(`${table}.${column}=${value}`);
            return {
              data: table === "teacher_profiles" ? [{ phone_number: phone }] : [state],
              error: null,
            };
          },
        }),
      };
    },
    rpc: async (name: string, args: unknown) => {
      calls.rpc.push([name, args]);
      return { data: recorded, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const accepted = async () => ({ accepted: true as const });
const failed = (category: "target_not_allowed" | "provider_failure" | "network_failure") => async () => ({
  accepted: false as const,
  category,
  stage: "send",
  detail: "private provider detail",
});

test("a consenting teacher's test is sent to their saved phone and recorded", async () => {
  const { admin, calls } = database({});
  const sent: unknown[] = [];
  const result = await sendTeacherTestNotification(admin, USER, config, async (c, to, text) => {
    sent.push([to, text]);
    return { accepted: true };
  });
  assert.deepEqual(result, { status: "registered" });
  assert.deepEqual(sent, [[PHONE, TEST_MESSAGE]]);
  assert.deepEqual(calls.rpc, [
    [
      "record_teacher_notification_send",
      { p_user_id: USER, p_phone: PHONE, p_attempt: "attempt-1", p_project_id: PROJECT, p_result: "accepted" },
    ],
  ]);
  // Only the verified user's own rows are read.
  assert.ok(calls.reads.every((read) => read.endsWith(`user_id=${USER}`)));
});

test("a recipient not on the allowlist stays activating", async () => {
  const { admin, calls } = database({});
  const result = await sendTeacherTestNotification(admin, USER, config, failed("target_not_allowed"));
  assert.deepEqual(result, { status: "pending" });
  assert.equal((calls.rpc[0] as [string, { p_result: string }])[1].p_result, "target_not_allowed");
});

test("provider failures are recorded, then raised without provider details", async () => {
  for (const category of ["provider_failure", "network_failure"] as const) {
    const { admin, calls } = database({});
    await assert.rejects(
      sendTeacherTestNotification(admin, USER, config, failed(category)),
      (error: Error) => !/private provider/.test(error.message) && /send failed/.test(error.message),
    );
    assert.equal((calls.rpc[0] as [string, { p_result: string }])[1].p_result, category);
  }
  const { admin } = database({});
  await assert.rejects(
    sendTeacherTestNotification(admin, USER, config, async () => {
      throw new Error("private provider detail");
    }),
    (error: Error) => !/private provider/.test(error.message),
  );
});

test("without current consent and a matching phone nothing is sent", async () => {
  const noSend = async () => {
    assert.fail("must not send");
  };
  const cases: Record<string, Parameters<typeof database>[0]> = {
    "not opted in": { state: { ...consent, notification_opt_in: false } },
    "no phone saved": { phone: null },
    "bad phone": { phone: "5551234567", state: { ...consent, notification_phone: "5551234567" } },
    "phone changed since consent": { state: { ...consent, notification_phone: "+15557654321" } },
    "other Photon project": { state: { ...consent, photon_project_id: "another" } },
    "never registered": { state: { ...consent, registration_attempt: null } },
    "no settings row": { state: {} },
  };
  for (const [label, input] of Object.entries(cases)) {
    const { admin, calls } = database(input);
    await assert.rejects(sendTeacherTestNotification(admin, USER, config, noSend), /consent unavailable/, label);
    assert.equal(calls.rpc.length, 0, label);
  }
});

test("missing Spectrum credentials never reach the database or provider", async () => {
  const { admin, calls } = database({});
  await assert.rejects(
    sendTeacherTestNotification(admin, USER, { projectId: PROJECT }, async () => {
      assert.fail("must not send");
    }),
    /configuration unavailable/,
  );
  assert.equal(calls.reads.length, 0);
});

test("a consent change during the send is not claimed as enabled", async () => {
  const { admin } = database({ recorded: false });
  await assert.rejects(sendTeacherTestNotification(admin, USER, config, accepted), /not applied/);
});

test("the shared sender validates before it connects", async () => {
  await assert.rejects(sendSpectrumMessage(config, "not-a-phone", "hi"), /E\.164/);
  await assert.rejects(sendSpectrumMessage(config, PHONE, ""), /Invalid message/);
  await assert.rejects(sendSpectrumMessage(config, PHONE, "x".repeat(501)), /Invalid message/);
  await assert.rejects(sendSpectrumMessage({ projectId: PROJECT }, PHONE, "hi"), /credentials missing/);
});

test("the hosted route is Node-native: no Python, no subprocess, no static phone, no public env", () => {
  const route = readFileSync(new URL("../app/api/notifications/test/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /child_process|spawn|python|\.venv|notification_activation/);
  assert.doesNotMatch(route, /SPECTRUM_TEACHER_PHONE|CUES_USE_STATIC_TEACHER_PHONE/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_SPECTRUM/);
  const send = readFileSync(new URL("../lib/notification-send.ts", import.meta.url), "utf8");
  assert.doesNotMatch(send, /SPECTRUM_TEACHER_PHONE|CUES_USE_STATIC_TEACHER_PHONE/);
});

test("the local sender and the hosted route share one provider implementation", () => {
  const local = readFileSync(new URL("../../cues/src/notify.ts", import.meta.url), "utf8");
  assert.match(local, /web\/lib\/spectrum-send/);
  assert.doesNotMatch(local, /from "spectrum-ts/);
  const shared = readFileSync(new URL("../lib/spectrum-send.ts", import.meta.url), "utf8");
  assert.match(shared, /from "spectrum-ts\/providers\/imessage"/);
  assert.doesNotMatch(shared, /^import "server-only"|process\.env/m);
});
