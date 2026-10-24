import { contactsScript, parseContactQuery } from "./contacts-script.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const MESSAGES_PROVIDER = "mengel-messages";
const senderNote = "Messages on this Mac chooses the sending identity. To send from your number, select it in Messages > Settings > iMessage > Start new conversations from.";

export const MESSAGES_TOOLS = [
  {
    providerIdentifier: MESSAGES_PROVIDER, name: "messages_search_contacts", toolName: "search_contacts",
    description: "Look up a named person in the user's Mac Contacts. For requests like 'text Tristan in my contacts', call this before asking for a phone number. Returns matching names, labeled phones and emails. If there is one matching contact with a preferredRecipient, use it directly; ask a short disambiguation only when multiple people or numbers match. Never invent a number or country code.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Person's name or nickname, e.g. Tristan. Search names only, not the whole user request." } }, required: ["query"], additionalProperties: false },
  },
  {
    providerIdentifier: MESSAGES_PROVIDER, name: "messages_get_status", toolName: "get_status",
    description: `Check the connected iMessage account on this Mac. Optionally check that a recipient resolves without sending anything. Use this to diagnose a send failure. Does not read conversations. ${senderNote}`,
    inputSchema: { type: "object", properties: { recipient: { type: "string", description: "Optional exact phone number or email to check without sending." } }, additionalProperties: false },
  },
  {
    providerIdentifier: MESSAGES_PROVIDER, name: "messages_send", toolName: "send",
    description: `Send an iMessage through the user's Messages account on this Mac, including when the remote computer is on Holly. Use only when the user asks to send a specific message to a specific recipient. For a named recipient, use messages_search_contacts first instead of asking the user for their number. Pass the returned recipient number or email; do not add or guess a country code. Ask only if the lookup is ambiguous or no usable address is found. Reuse request_id for retries of the same send; do not automatically retry a delivery-unknown result. Success means Messages accepted the message, not that the recipient received it. ${senderNote}`,
    inputSchema: { type: "object", properties: {
      recipient: { type: "string", description: "Exact recipient phone number or iMessage email address, preferably returned by messages_search_contacts." },
      text: { type: "string", description: "Exact message text to send." },
      request_id: { type: "string", description: "Unique ID for this send; reuse it if this same operation is retried." },
    }, required: ["recipient", "text", "request_id"], additionalProperties: false },
  },
] as const;

type SendRequest = { recipient: string; text: string; request_id: string };
type ToolResult = { result: { case: "success"; value: { content: { content: { case: "text"; value: { text: string } } }[]; isError: boolean } } };
function result(value: unknown, isError = false): ToolResult {
  return { result: { case: "success", value: { content: [{ content: { case: "text", value: { text: JSON.stringify(value) } } }], isError } } };
}
export function parseMessageRequest(raw: unknown): SendRequest {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Message arguments must be an object.");
  const value = raw as Record<string, unknown>;
  if (typeof value.recipient !== "string" || typeof value.text !== "string" || typeof value.request_id !== "string") throw new Error("Provide recipient, text, and request_id.");
  const recipient = value.recipient.trim();
  if (!/^(?:\+[1-9]\d{6,14}|\d{7,15})$/.test(recipient) && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) throw new Error("Look up the recipient with messages_search_contacts, then use their returned phone number or iMessage email address.");
  if (recipient.length > 254 || !value.text.trim() || value.text.length > 20_000 || value.text.includes("\0")) throw new Error("Message must contain text and be at most 20,000 characters.");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value.request_id)) throw new Error("request_id must be 8–128 letters, numbers, underscores, or hyphens.");
  return { recipient, text: value.text, request_id: value.request_id };
}

// AppleScript uses typed enumeration constants. JXA's string-based serviceType
// filter raises -1700 (Can't convert types) in current Messages versions.
export function appleScriptString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}
export function messagesScript(request?: SendRequest, checkRecipient?: string): string {
  const recipient = request?.recipient ?? checkRecipient;
  const success = request == null
    ? { available: true, transport: "iMessage", sender: "Messages default", ...(recipient == null ? {} : { recipientResolved: true }) }
    : { status: "submitted", deliveryConfirmed: false };
  return `set stageName to "account"
try
  with timeout of 45 seconds
    tell application id "com.apple.MobileSMS"
      set matchingAccounts to every account whose service type is iMessage
      if (count matchingAccounts) is 0 then error "No iMessage account" number 50001
      set readyAccounts to {}
      repeat with candidate in matchingAccounts
        if enabled of candidate then
          if connection status of candidate is connected then set end of readyAccounts to contents of candidate
        end if
      end repeat
      if (count readyAccounts) is 0 then error "iMessage disconnected" number 50002
      if (count readyAccounts) is greater than 1 then error "Multiple iMessage accounts" number 50003
      set targetAccount to item 1 of readyAccounts
      ${recipient == null ? "" : `set stageName to "recipient"
      set targetParticipant to participant ${appleScriptString(recipient)} of targetAccount
      set resolvedID to id of targetParticipant
      if resolvedID is "" then error "Recipient unavailable" number 50004`}
      ${request == null ? "" : `set stageName to "send"
      send ${appleScriptString(request.text)} to targetParticipant`}
    end tell
  end timeout
  return ${appleScriptString(JSON.stringify(success))}
on error errorText number errorNumber
  return "{\\"bridgeError\\":true,\\"stage\\":\\"" & stageName & "\\",\\"code\\":" & (errorNumber as text) & "}"
end try`;
}

export function messagesBridgeError(value: unknown): string | null {
  if (value == null || typeof value !== "object" || !(value as Record<string, unknown>).bridgeError) return null;
  const failure = value as Record<string, unknown>;
  const code = typeof failure.code === "number" ? failure.code : 0;
  const stage = ["account", "recipient", "send"].includes(String(failure.stage)) ? String(failure.stage) : "bridge";
  const prefix = `Messages ${stage} failed (macOS error ${code}). `;
  const delivery = stage === "send" ? " Delivery is unknown; check Messages before trying again." : " No message was sent.";
  const reason = code === -1743 ? "Allow Mengel to control Messages in System Settings > Privacy & Security > Automation."
    : code === 50001 ? "Sign in to iMessage in Messages on this Mac."
    : code === 50002 ? "The iMessage account is disconnected. Open Messages and let it reconnect."
    : code === 50003 ? "More than one connected iMessage account is available. Select a single account in Messages."
    : stage === "recipient" ? "Messages could not resolve that recipient. Check their saved phone number or iMessage email."
    : code === -1712 ? "Messages did not respond in time."
    : "Messages rejected the operation.";
  return prefix + reason + delivery;
}

export function runMessagesScript(script: string, application: "Messages" | "Contacts" = "Messages", language: "AppleScript" | "JavaScript" = application === "Messages" ? "AppleScript" : "JavaScript"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", language, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-32_768); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_096); });
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error(`Could not start the macOS ${application} bridge.`)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error(application === "Contacts" ? "Contacts lookup timed out. Try a more specific name." : "Messages timed out. Delivery is unknown; check Messages before sending again.")); return; }
      if (code !== 0) {
        // Do not return raw interpreter errors: they can contain private message text.
        const detail = /-1743|not authorized/i.test(stderr)
          ? `Allow Mengel to control ${application} in System Settings > Privacy & Security > Automation.`
          : application === "Contacts" ? "Could not read Contacts. Check macOS Automation permission for Contacts, then try again."
          : /Sign in to iMessage/.test(stderr) ? "Sign in to iMessage in Messages on this Mac first."
          : "Messages could not complete the request. Check the account and recipient in Messages; do not automatically retry a send.";
        reject(new Error(detail)); return;
      }
      try {
        const value: unknown = JSON.parse(stdout.trim());
        const bridgeError = messagesBridgeError(value);
        if (bridgeError != null) reject(new Error(bridgeError));
        else resolve(value);
      } catch { reject(new Error(application === "Contacts" ? "Contacts returned an unexpected response. Try a more specific name." : "Messages returned an unexpected response. Check Messages before retrying a send.")); }
    });
    child.stdin.end(script);
  });
}

export function createMessagesTools(deps: {
  readonly platform?: string;
  readonly permission: () => string;
  readonly confirmSend: (request: SendRequest) => Promise<boolean>;
  readonly runScript?: (script: string, application?: "Messages" | "Contacts") => Promise<unknown>;
}) {
  const attempts = new Map<string, { hash: string; promise: Promise<ToolResult> }>();
  const run = deps.runScript ?? runMessagesScript;
  return {
    list: () => (deps.platform ?? process.platform) === "darwin" ? [...MESSAGES_TOOLS] : [],
    async call(name: string, raw: unknown): Promise<ToolResult> {
      try {
        if ((deps.platform ?? process.platform) !== "darwin") throw new Error("Messages sending requires the Mengel Mac app.");
        if (deps.permission() === "never") throw new Error("Local computer execution is disabled in Mengel settings.");
        if (name === "search_contacts") return result(await run(contactsScript(parseContactQuery(raw)), "Contacts"));
        if (name === "get_status") {
          const input = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>).recipient : undefined;
          const recipient = input === undefined ? undefined : parseMessageRequest({ recipient: input, text: "check", request_id: "readonly-check" }).recipient;
          return result({ ...await run(messagesScript(undefined, recipient)) as object, senderNote });
        }
        if (name !== "send") throw new Error("Unknown Messages tool.");
        const request = parseMessageRequest(raw);
        const hash = createHash("sha256").update(JSON.stringify([request.recipient, request.text])).digest("hex");
        const previous = attempts.get(request.request_id);
        if (previous != null) {
          if (previous.hash !== hash) throw new Error("This request_id was used for a different message. Use a new ID for a new send.");
          return await previous.promise;
        }
        // Keep uncertain outcomes too: retries must not accidentally send twice.
        if (attempts.size >= 1_000) throw new Error("Message request cache is full. Restart Mengel before starting another send.");
        const promise = (async () => {
          try {
            if (deps.permission() !== "always" && !await deps.confirmSend(request)) return result({ status: "cancelled", sent: false });
            if (deps.permission() === "never") throw new Error("Local computer execution was disabled before sending.");
            return result({ ...await run(messagesScript(request)) as object, recipient: request.recipient, request_id: request.request_id, senderNote });
          } catch (error) { return result({ error: error instanceof Error ? error.message : "Messages request failed." }, true); }
        })();
        attempts.set(request.request_id, { hash, promise });
        return await promise;
      } catch (error) { return result({ error: error instanceof Error ? error.message : "Messages request failed." }, true); }
    },
  };
}
