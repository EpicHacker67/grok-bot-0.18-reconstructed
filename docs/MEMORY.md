# Routed memory

Mengel's Codex, Claude Code, and OpenRouter conversations use the host's existing file-backed memory system. The coordinator requests bounded memory context before inference and exposes memory tools alongside browser/computer and connected plugin tools. It does not copy memory into the original Grok Bot installation.

## Storage and scope

- Agent facts: `agents/<id>/memory/profile.md` and dated `log/YYYY-MM.md` under the isolated host's data root. These are the same records used by the native Memories UI.
- Shared user facts: `user-memory/agents/<writer-id>/` with the same profile/log format.
- Project facts: `projects/<slug>/memory/agents/<writer-id>/`. Membership is stored in each agent's `projects.json`. Only joined projects enter recall.
- Tools may write/forget only the current agent's contributions. A tool argument cannot substitute another agent's ID. Unknown agents and unsafe project paths are rejected.

`memory_write` saves profile, log, or note facts; `memory_search` recalls older records; `memory_forget` removes exact recorded content; `memory_project` lists/creates/joins/leaves shared memory projects. Existing chat history remains separate: forgetting a durable fact does not erase a message containing it.

Before each reply, the router loads relevant keyword matches, profile facts, and recent logs, retaining source/scope/date metadata within a 16,000-character fact budget. The model receives instructions to treat facts as data, prefer current user instructions, and resolve conflicts in agent → project → user order. Older facts remain searchable.

After a successful exchange with useful user input, a separate tool-free extraction request can retain explicitly user-stated facts in agent memory. It uses the selected provider and consumes additional model usage. Extraction sees the latest user text and existing agent memories, not page/tool contents or the full old transcript. Explicit memory changes suppress extraction for that turn. Maintenance is ordered before the next turn, but an extraction failure never changes the completed reply into an error.

Extracted changes use the existing synthesis store: explicit records are protected from automatic removal, deleted records have tombstones, and concurrent edits invalidate stale extraction results. The native feature-gated background dreaming service is not required for routed memory to work.

## Verification

`tests/routed-memory.test.mjs` covers persistence across service restart, recall without chat history, deduplication, agent isolation, shared memory ownership, project membership, path validation, Unicode-compatible text storage, explicit-record protection, stale extraction, and deletion tombstones.

Existing conversation history is not retroactively mined. Memories begin with existing host records, explicit remember requests, and new exchanges. This change does not add vector search or transcript compaction; the routed chat's separate 200-message retention limit remains unchanged.

Installation check (October 16, 2026): all 98 repository checks and packaged-app verification passed. The installed ASAR matches the verified build. Live save/restart/recall/forget acceptance passed through the installed app: the agent saved a temporary log fact, retrieved it, recalled it through memory_search after a full app restart, forgot it, and confirmed zero search matches. The host memory file independently confirmed the write, persistence, and removal. The temporary fact was cleaned up; existing memories were left intact.
