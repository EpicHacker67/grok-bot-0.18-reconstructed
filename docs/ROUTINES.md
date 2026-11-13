# Native routines in routed conversations

Codex, Claude Code, and OpenRouter can access `routine_list` and `routine_manage` through the coordinator. They use the same gateway methods and native automation store as the Routines panel, rather than a second scheduler or the four-hour continuation task store.

`routine_manage` supports create, partial update, pause, resume, and delete for the current agent. New routines accept cron, cron aliases, or interval schedules. Cron schedules pin an explicit IANA timezone, defaulting to the configured user timezone, so a Linux container timezone does not shift a requested local time. Partial updates preserve omitted fields, including enabled state and existing event triggers. Creating event-triggered routines is not exposed by this tool yet.

The agent ID is bound by the coordinator, never supplied by the model. Operations are serialized, repeated identical creates reuse the existing routine, and same-name conflicting creates require an update. Mutations are never blindly retried after transport errors. Every mutation reads back the native state before reporting success; a silent backend rejection is an error. Cancellation prevents further calls, though an already dispatched mutation can still finish.

Routine instructions distinguish recurring schedules from bounded background continuations and require user authorization for creation or changes. The tools use the existing UI gateway management operations; they do not use the native runner's turn-specific automation auto-review callback. They do not change the native scheduler, cloud synchronization, run execution, or its approval behavior. Saving a routine is not a guarantee that a future run will succeed, or that the app can run while unavailable.

Tests cover native file persistence, timezone/DST handling, duplicate prevention, partial updates, toggles/deletion, invalid input, agent scoping, uncertain saves, and cancellation. Router integration covers direct provider tools and the Claude MCP bridge. No user routines or external services are executed by these tests.

## Verification (2026-11-12)

`npm run check` passed all 139 tests. `npm run verify` passed, and the installed ASAR matches the packaged build: `0b4f70ccea6862ca1e38f7ebe78e7e297ee1aef7e976ca47132aee90598ec030`. The previous bundle is retained at `/tmp/Mengel-before-routines-2026-11-12.app`.

The current Node version exposed a provider transport mismatch between built-in fetch and the separately installed undici Agent. Provider fetch now defaults to the matching undici implementation, preserving isolated connection settings. Existing streaming and cancellation transport tests pass on Node 26.13.0. Packaging used the working system Python for node-gyp because the Homebrew Python installation could not load its XML dependency.

Live verification in the installed app succeeded: the routed agent called `routine_list` and reported the native store's empty result with America/Chicago timezone. The user's subsequent in-app request created an enabled native routine; a separate read of its stored config confirmed `CRON_TZ=America/Chicago 0 17 * * *`. This verifies creation and persistence, not a future scheduled execution.
