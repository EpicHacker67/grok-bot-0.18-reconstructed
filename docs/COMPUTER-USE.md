# Mengel computer and browser controls

Routed providers share the existing remote Chrome profile and display. Browser tools return page text and generated element references; desktop tools cover applications and visual controls that cannot be represented as page elements. The original Grok Bot installation is separate.

## Working efficiently

- Use connected service tools for supported service operations.
- Inspect browser tabs and current page before acting. Navigation, clicks, filling, selection, scrolling, and history return an updated snapshot in the same model round.
- Use `browser_read` for full rendered article text, phrase search, and bounded continuation ranges. It leaves control references unchanged.
- Use `browser_wait` for a visible/hidden text condition after asynchronous work. Never replay a submission to wait for its result.
- Use `browser_fill_form` to fill up to eight already-observed text fields, native selects, and checkboxes in one browser call. Each field takes a ref and exactly one of `value`, `values` (native option values), or `checked`. An optional `submitRef` clicks once after all fields succeed; `waitFor` waits for a known confirmation in that button's frame. Batch only authorized, deterministic steps that do not depend on unseen intermediate state.
- Form batches validate all refs and control types before editing, re-resolve each ref before use, and stop on the first failure. Partial progress and uncertainty are returned with fresh page state. Earlier edits are not rolled back; never replay the whole batch after a timeout or stale ref without inspecting the result.
- Routed browser snapshots abbreviate ordinary page text while retaining headings, controls, native select state/options, and status/alert messages. Use `browser_read` to retrieve full passages or `browser_snapshot` with `compact: false` for a detailed snapshot. A compact result is not evidence that omitted text is absent.
- Snapshots include visible embedded frames and open shadow roots. A refresh clears old references across all frames. Detached elements and closed explicit tabs fail safely.
- Use a desktop screenshot for visual tasks. It reports original pixel dimensions. Clicking, typing, keys, scrolling, hovering, and dragging return a new screenshot by default. Disable that observation only for a deterministic intermediate step.
- Desktop operations are serialized. Readiness checks are reused for short action bursts, refreshed after 30 seconds or an error. Actions are never automatically retried.
- Browser endpoint discovery matches the configured display's persistent profile, including legacy port assignments. It does not create a separate agent Chrome profile.

## Verification

`npm run check` covers argument validation, isolation and endpoint selection, serialized calls, readiness recovery, stale references, iframe targeting, bounded article reading, conditional waits, gesture arguments, screenshot dimensions, and shell deadlines. `npm run verify` checks the packaged app. Unit tests alone do not establish live task quality.

`tests/fixtures/computer-use-workbench.cjs` is a disposable local fixture for end-to-end evaluation through the Mengel UI. Run it in the desktop container; it listens only on loopback at port 18766 and stops after 30 minutes. It records synthetic test events to `/tmp/mengel-computer-use-workbench.jsonl`.

Live acceptance tasks:

1. Open the workbench in a new tab. Enter a Unicode test name, choose Ready, enable Include summary, and save exactly once. Verify the delayed success state and one matching server event.
2. Fill and save the embedded frame's note and activate the shadow control. Verify their visible results and matching events.
3. Read the long article and report its delivery window and package code. Verify exact values against the fixture, without downloading source or using shell to read it.
4. Open the reference link, read its code, return to the workbench, and close only the test-created reference tab. Existing user tabs must survive.
5. Use a screenshot and desktop drag to move the canvas square into its target; verify the visible confirmation and server event.
6. Verify a fresh interaction after reconnect/relaunch. Keep browser profiles, cookies, clipboard behavior, and working audio intact.

Live acceptance completed on October 16, 2026, through the installed Mengel app after a full restart:

- The form saved once per requested submission, including the exact Unicode value `Café 東京`, Ready mode, and the checked summary option. The fixture event log confirmed the values and submission counts.
- The embedded frame saved `Frame verified`; the shadow control activated. Both produced matching fixture events and visible confirmations.
- The agent correctly reported Thursday, 14:30–16:00 and `ORBIT-739` from the rendered long article, with shell/source inspection excluded from its task.
- The agent opened the reference, reported `LANTERN-42`, returned to the workbench, and closed the reference tab while preserving the existing X tab.
- The canvas drag produced a matching fixture event and a visible `Drag verified` confirmation, independently inspected in Mengel's computer view.
- The agent completed fresh browser actions after restart, and the remote computer view reconnected successfully. This run did not separately retest audio playback or clipboard synchronization.

The first test prompt's simulated keystrokes lost its Unicode characters before reaching Mengel. A second prompt pasted through the app UI preserved them and passed the Unicode check. These synthetic tasks establish working controls, not a general success-rate or speed benchmark for arbitrary websites.

## Scored smoke benchmark — October 16, 2026

The randomized fixture in `tests/fixtures/browser-benchmark.cjs` records server-side outcomes and private answer keys. It runs on container loopback port 18767, writes `/tmp/mengel-browser-benchmark.json`, and stops after 45 minutes. Submit tasks through the installed app; never expose the answer key to the tested agent.

One valid bundled trial using Codex `gpt-6.1-sol`, High effort, and Fast mode passed all eight scored checks: exact Unicode form values, embedded frame, shadow control, long-article code, reference-tab code, delayed shipment result, canvas drag, and avoiding the conflicting page instruction. Saves and lookups occurred exactly once. Page opening to answer submission took 114.666 seconds. The agent made 27 provider requests with zero connection retries; this is not a tool-call count. The 18 focused browser/profile component tests also passed.

The attempted second trial is excluded: native input automation submitted only the opening paragraph and omitted the task list and exact form values. It cannot support a repeated success-rate or timing claim. Native input and observation delays also affected setup. This is a small synthetic smoke benchmark, not a broad real-site benchmark or comparison with the previous implementation.

Raw scored events, model configuration, request metadata, exclusions, and limitations are saved in `docs/benchmarks/browser-2026-10-16.json`.

## Browser isolation and turn liveness (2026-10-23)

Routed browser calls now list tabs directly from Chrome's target metadata, then connect Playwright only to the chosen target through a temporary loopback relay. Browser-wide auto-attachment could wait indefinitely for an unrelated blocked renderer. The relay preserves child-frame attachment and attaches newly created tabs, but does not revive or reload unrelated tabs. Explicit tab selection may activate that requested tab. Closed explicit views still fail instead of changing another tab.

Frame inspection has bounded deadlines. A stalled child frame is marked unavailable while healthy main-page controls remain usable. Chrome startup polls readiness immediately instead of waiting for the browser process to exit first.

A standalone isolated-Chrome regression (`tests/fixtures/scoped-browser-connection.cjs`) deliberately blocks a background renderer. The old browser-wide connection timed out; the scoped path listed both tabs in 160 ms and read the healthy page in 379 ms, then clicked, opened a new tab, and closed that test tab successfully. The blocked tab was left untouched. These are fixture timings, not general website performance guarantees.

The coordinator's former fixed ten-minute turn deadline is now a ten-minute inactivity watchdog. Model reasoning/text, tool requests, and tool completions reset it; transport heartbeats do not. A four-hour total ceiling remains. An actual stall produces a user-facing pause explanation rather than the generic “Turn time limit reached” error. Unit and router integration tests simulate productive turns beyond the old deadline while retaining cancellation and idle-timeout coverage.

Installed validation: `npm run check` passed 120 tests, followed by the added router integration test simulating 27 minutes of productive work. Packaging verification passed. Installed ASAR SHA-256: `00e3efb64142f2f58b8722aaf310c40f5ab6a8fc4963e6ba24594519658bbb59`. After restart, a read-only check through the actual Mengel UI successfully listed 20 tabs and read the visible Pangram dashboard. No form was submitted and no earlier task was resumed. Backup: `/tmp/Mengel-before-timeout-fixes-2026-10-23.app`.
