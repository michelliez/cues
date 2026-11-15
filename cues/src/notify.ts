// The provider logic is shared with the hosted endpoint: web/lib/spectrum-send.ts.
import { sendSpectrumMessage } from "../../web/lib/spectrum-send.ts";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Resolve relative to this sender, regardless of the Python caller's cwd.
loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
const diagnostic = console.error.bind(console);
// SDK logging can contain addresses; only emit our sanitized diagnostics.
console.log = console.info = console.warn = console.debug = console.error = () => {};
function safe(message: string) {
  for (const name of ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET",
    "SPECTRUM_TEACHER_PHONE", "SPECTRUM_SENDER_PHONE"]) {
    const value = process.env[name];
    if (value) message = message.split(value).join("[redacted]");
  }
  return message.replace(/\+\d[\d ()-]{6,}\d/g, "[phone]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

let stage = "input";
async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { message, destination } = JSON.parse(input);
  const phone = process.env.CUES_USE_STATIC_TEACHER_PHONE === "1"
    ? process.env.SPECTRUM_TEACHER_PHONE : destination;
  diagnostic(JSON.stringify({ cuesNotification: true, config: {
    nestedEnvLoaded: true, projectIdPresent: Boolean(process.env.SPECTRUM_PROJECT_ID),
    projectSecretPresent: Boolean(process.env.SPECTRUM_PROJECT_SECRET),
    teacherPresent: Boolean(phone), explicitSender: Boolean(process.env.SPECTRUM_SENDER_PHONE),
  }}));
  const outcome = await sendSpectrumMessage({
    projectId: process.env.SPECTRUM_PROJECT_ID,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET,
    senderPhone: process.env.SPECTRUM_SENDER_PHONE,
  }, phone, message, {
    onResponse: (sent) => {
      if (process.env.CUES_SPECTRUM_DEBUG !== "1") return;
      const shape = (value: unknown): unknown => {
        if (value == null) return { type: String(value) };
        if (Array.isArray(value)) return { type: "array", length: value.length, items: value.map(shape) };
        if (typeof value !== "object") return { type: typeof value };
        const row = value as Record<string, unknown>;
        return { type: "object", keys: Object.keys(row), fields: Object.fromEntries(
          Object.entries(row).filter(([key, val]) =>
            typeof val === "boolean" || (["id", "messageId", "requestId", "status"].includes(key) &&
              (typeof val === "string" || typeof val === "number")))
            .map(([key, val]) => [key, typeof val === "string" ? safe(val) : val])
        ) };
      };
      diagnostic(JSON.stringify({ cuesNotification: true, stage: "send", response: shape(sent) }));
    },
  });
  if (!outcome.accepted) {
    stage = outcome.stage;
    diagnostic(JSON.stringify({ cuesNotification: true, stage, error: safe(outcome.detail) }));
    process.stdout.write(JSON.stringify({ accepted: false, category: outcome.category }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ accepted: true }) + "\n");
}
main().catch((error) => {
  diagnostic(JSON.stringify({ cuesNotification: true, stage,
    error: safe(error instanceof Error ? error.message : String(error)) }));
  process.stdout.write(JSON.stringify({ accepted: false, category: "provider_failure" }) + "\n");
  process.exitCode = 1;
});
