import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/**
 * The one place Cues talks to Photon/Spectrum. Both the local sender (cues/src/notify.ts, run by
 * the Python agent) and the hosted test endpoint (web/app/api/notifications/test) call this, so
 * the provider logic exists once. It reads no environment and no files: credentials arrive as
 * arguments, and it never logs. It does not know about users, consent or databases.
 *
 * Do not import "server-only" here: the local sender runs this file outside Next.
 */
export const E164 = /^\+[1-9]\d{7,14}$/;
export const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 25_000;

export type SpectrumConfig = {
  projectId?: string;
  projectSecret?: string;
  /** Optional: send from this specific number. */
  senderPhone?: string;
};

export type SendFailure = "target_not_allowed" | "provider_failure" | "network_failure";
export type SendOutcome =
  | { accepted: true }
  | {
      accepted: false;
      category: SendFailure;
      /** Where it failed and the provider's message. For the local sender's redacted diagnostics
       * only: never show or log it unredacted, it can contain addresses. */
      stage: string;
      detail: string;
    };

export type SendHooks = {
  /** The provider's raw acknowledgement, for the local sender's debug output. */
  onResponse?: (response: unknown) => void;
  timeoutMs?: number;
};

/** Send one text to one E.164 number. Invalid input throws; provider trouble returns a category. */
export async function sendSpectrumMessage(
  config: SpectrumConfig,
  destination: string,
  message: string,
  hooks: SendHooks = {},
): Promise<SendOutcome> {
  if (typeof message !== "string" || !message || message.length > MAX_MESSAGE_LENGTH)
    throw new Error("Invalid message");
  if (typeof destination !== "string" || !E164.test(destination))
    throw new Error("Valid E.164 teacher destination required");
  if (!config.projectId || !config.projectSecret)
    throw new Error("Spectrum project credentials missing");

  let stage = "connect";
  let app: Awaited<ReturnType<typeof Spectrum>> | undefined;
  const work = (async (): Promise<SendOutcome> => {
    app = await Spectrum({
      projectId: config.projectId!,
      projectSecret: config.projectSecret!,
      providers: [imessage.config()],
    });
    const provider = imessage(app);
    stage = "resolve-teacher";
    const user = await provider.user(destination);
    stage = "resolve-space";
    const space = await provider.space.create(
      user,
      config.senderPhone ? { phone: config.senderPhone } : undefined,
    );
    stage = "send";
    const sent = await space.send(message);
    hooks.onResponse?.(sent);
    if (!sent || (Array.isArray(sent) && sent.length === 0)) throw new Error("No acknowledgement");
    return { accepted: true };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          accepted: false,
          category: "network_failure",
          stage,
          detail: "Timed out",
        }),
      hooks.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      work.catch((error: unknown): SendOutcome => {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          accepted: false,
          category: detail.includes("Target not allowed for this project")
            ? "target_not_allowed"
            : "provider_failure",
          stage,
          detail,
        };
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await app?.stop();
    } catch {
      /* Closing the connection must never change the result. */
    }
  }
}
