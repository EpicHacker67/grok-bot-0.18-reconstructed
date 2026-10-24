# Continuing work after a reply

Routed Codex, Claude Code, and OpenRouter conversations can save an ongoing user-requested task with `task_schedule`. A reply no longer has to be the end of that task. The coordinator checks due tasks every five seconds and gives the provider the saved objective, original request, and verified checkpoint. This is separate from durable user memory.

The model must explicitly save a task before promising continuation. Existing conversations are not automatically enrolled. Ask Mengel to resume or start the unfinished task after installing this change. The native Cursor route is unchanged.

- `task_schedule`: start one task per conversation, with its next check 15–600 seconds away.
- `task_status`: read progress, status, next check, and blockers.
- `task_checkpoint`: save progress and wait, complete, block, or cancel.
- `task_resume`: explicitly resume after the user resolves a blocker; renew the budget.
- Sending **stop**, **cancel**, or **pause** (also “stop the task”, etc.) is handled directly, without waiting for a model decision. Pause preserves the task for resumption; stop/cancel end it.

Tasks are saved atomically with owner-only permissions in `sand-data/inference-router-tasks.json`. Waiting tasks resume after reopening Mengel. Interrupted runs are marked for recovery: inspect current state before acting, and never blindly repeat an uncertain external change. The app must be running and the Mac awake to perform checks. After four elapsed hours or 240 checks, the task pauses until the user asks to resume.

The shared desktop has one routed provider turn at a time. Foreground messages interrupt an active background model request and revoke further tool calls; an already executing tool can still finish. Previously queued prompts are invalidated by a stop for that conversation. Ordinary interruptions defer the task without consuming its failure allowance. Connection/provider failures back off and pause after three failures. A provider change pauses the task; a deleted agent cancels it.

A continuation must save its next state. If it forgets, the coordinator makes one checkpoint-only recovery call (90-second limit) using the saved task, recent bounded tool observations, and the unverified final reply. Browser/plugin actions are unavailable during recovery, so completed actions are not replayed. If this pass also fails to save, the task pauses with a short explanation and retains its prior checkpoint. Cancellation and explicit blockers still win. Sign-in, missing information, required approval, and uncertain actions must be checkpointed as blockers. Completion requires observed evidence; elapsed video time alone is not proof. These instructions do not bypass authentication or create access to a signed-out account.

Routine checks and synthetic continuation prompts do not pollute the chat or user memory. Completion and blockers appear in chat using the separate `message` field (at most 500 characters). Detailed `progress` notes stay in the task file; legacy checkpoints without a public message use a short fallback. Pausing or hitting a limit preserves those notes for resumption. Task progress can be requested at any time.

Validation uses a synthetic provider and temporary files: persistence/reopening, interrupted recovery, sign-in pause/resume, quiet waiting, completion notification, cancellation, backoff, bounded execution, corrupt-file preservation, and cancellation between Codex tool calls. No real course videos or messages are used in these tests.

## Installed verification (2026-10-19)

The full `npm run check` passed 114 tests before the final cancellation refinement. Source typechecking and all 12 focused router/task/provider-failure tests then passed, including the added foreground-interruption test. The Codex transport cancellation test also passed. A live authenticated Codex run with only synthetic fixture/task tools saved a waiting task, reopened its persisted state, read a changed fixture, and checkpointed verified completion. This did not touch the user's browser or course account.

`npm run verify` passed. Installed and packaged ASAR SHA-256: `356e531ce77a6909a71377c094d2a9b7eeda148df62df263bf8392f7e0a0c0f2`. Previous Mengel bundle retained at `/tmp/Mengel-before-persistent-tasks.app`.

## Checkpoint recovery verification (2026-10-24)

`npm run check` passed all 129 tests, including restricted recovery through both direct tools and the Claude MCP bridge, cancellation during repair, one-pass recovery failure, private-note separation, and legacy paused-task/transcript migration. `npm run verify` passed. Installed Mengel was reopened and its existing internal-checkpoint dump visibly changed to the short pause message; the saved task stays paused until the user resumes it.

Installed/package ASAR SHA-256: `68be09c6798d6e045f64b5403e1c6e9fec6ae7c5e39cfe9a32121745a4f2fa12`. Previous app retained at `/tmp/Mengel-before-checkpoint-recovery-2026-10-24.app`.
