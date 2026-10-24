# Sending iMessages from Mengel

The macOS app exposes `messages_search_contacts`, `messages_get_status`, and `messages_send` to the Codex,
Claude Code, and OpenRouter routes. Sending runs through Messages on the Mac,
even when the remote computer runs in the Holly container. It does not replace
an existing incoming-message plugin or add an incoming-message listener.

Sign in to Messages on the Mac. In **Messages → Settings → iMessage**, select
your phone number under **Start new conversations from**. The bridge uses the
sending identity chosen by Messages; it cannot override that setting. Existing
conversations may retain their original sending identity. See
[Apple's iMessage settings guide](https://support.apple.com/en-lk/guide/messages/icht39422/mac).

Ask Mengel to message someone by name, for example “Text Tristan in my contacts
and say hi.” It searches Contacts on this Mac by name or nickname first. One
matching contact with one number (or a unique mobile number) resolves directly.
Multiple matching people or equally suitable numbers require a short
clarification. It uses saved numbers without inventing a country code. You can
also provide an exact phone number or iMessage email address.
The first use may trigger macOS's Automation permission prompt for Contacts or Messages.
Mengel respects **Settings → General → Execution on Local Computer**: Never
blocks the tool; Ask every time shows the recipient and exact message with
Cancel/Send buttons; Allow automatically uses the saved permission.

The tool sends iMessage text only. It does not fall back to SMS or RCS, send
attachments, or verify delivery. `submitted` means Messages accepted the send,
not that the recipient received it. Check Messages if a call times out or fails;
do not automatically retry a potentially completed send.

Use one `request_id` per intended message and reuse it for retries. Mengel
remembers successful, cancelled, and uncertain attempts for the current app
session, so a concurrent or repeated call does not send twice. The cache resets
when the app restarts. A new ID is required after changing the text or recipient.
Message contents are passed to the scripting bridge over stdin, never through
a shell command or command-line arguments. Messages uses native AppleScript
account and participant references; Contacts lookup uses JavaScript for Automation.
`messages_get_status` accepts an optional recipient for a read-only account and
address check. Failures identify the stage and macOS error code without exposing
message text. Account and recipient failures happen before sending; a send-stage
failure is treated as uncertain and must not be retried automatically.
Tests compile the Messages scripts and mock tool execution; they do not send real messages.
