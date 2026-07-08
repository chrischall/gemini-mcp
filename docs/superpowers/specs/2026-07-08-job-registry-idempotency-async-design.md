# Job registry: idempotency (#53) + async (#52) — design

Date: 2026-07-08. Closes #53 (PR 1) and #52 (PR 2, stacked).

## Problem

When an MCP host times out a long generation (`-32001`), the server-side job
usually completes anyway. Two consequences from field feedback (2026-07-06):

- **#53 duplicate billing** — a blind re-issue of the same call dispatches a
  *second* paid upstream generation.
- **#52 no completion signal** — the caller can't tell whether the job finished
  without `ls`-ing the output dir.

The heartbeat + sidecar recovery already shipped (PR #61) reduce how often this
bites, but there is no server-side guard and no first-class async handle.

## Core primitive — `src/jobs.ts` (new module)

A per-process, in-memory registry, same lifetime/reset pattern as
`lastInteractionId` in `interact.ts` (a test-only reset export clears it).

```ts
type JobStatus = 'running' | 'done' | 'failed';
interface JobEntry {
  jobId: string;                 // crypto.randomUUID()
  toolName: string;
  fingerprint: string;           // sha256 of the request identity (pre-seed)
  idempotencyKey?: string;
  status: JobStatus;
  promise: Promise<CallToolResult>;
  result?: CallToolResult;       // set on 'done'
  error?: { message: string; hint?: string }; // set on 'failed'
  createdAt: number;
  settledAt?: number;
}
```

- **Lookups:** by `jobId` (poll tool) and by `fingerprint` / `idempotencyKey`
  (dedup).
- **Eviction:** TTL `JOB_TTL_MS` (default 600_000 = 10 min) + max `JOB_MAX`
  (default 64) entries, evict oldest-settled first — bounds memory even when
  entries hold inline base64 results.
- `Date.now()` / `crypto.randomUUID()` are fine at runtime (only Workflow
  scripts ban them).

## Dispatcher — `dispatch(opts, work)` (in `jobs.ts`)

Every generation tool routes its handler body (everything after the
confirm-gate) through this:

```ts
dispatch(
  { extra, toolName, fingerprint, idempotencyKey?, async? },
  work: () => Promise<CallToolResult>,
): Promise<CallToolResult>
```

Logic:

1. **Dedup lookup**
   - If `idempotencyKey`: match a `running` OR recently-`done` entry by key.
   - Else: match only a **`running`** entry by `fingerprint` (the safe in-flight
     auto-dedup — two truly-simultaneous identical requests are a timeout-retry
     race, never an intentional variation).
   - On hit:
     - `async` requested → return that entry's `{ job_id, status }` immediately.
     - else → `await entry.promise`, return the result **annotated
       `reused: true`** (+ `reused_job_id`).
2. **Miss** → create an entry: `jobId = randomUUID()`, start `work()`, register
   `status: running` with the promise; a `.then/.catch` transitions the entry to
   `done`/`failed` and stamps `settledAt`.
   - `async` requested → return `{ job_id, status: 'running' }` immediately (no
     await, no `-32001`).
   - else → `await` the promise and return the result (failures propagate as
     today).

### Reuse annotation

Both disk and inline results carry the JSON meta as `content[0].text` (verified:
"meta is always emitted; content[0] = text meta, content[1] = image"). So
`annotateReused()` parses `content[0].text`, sets `reused: true` +
`reused_job_id`, re-stringifies, and returns a shallow-cloned result — uniform
across modes, no re-`emit()` and no re-write to disk.

### Fingerprint

`fingerprintRequest(toolName, parts)` → sha256 of canonical JSON over the
request's stable identity: resolved model, prompt/input text, image
size/aspect/thinking level, input-image digest (base64 string or resolved path),
`google_search`, video refs, and `count`. **Excludes** the server-picked seed
and output filename/dir, so a blind re-issue of the same args fingerprints
identically. `from_clipboard` contributes a flag only (its bytes vary; only the
in-flight window dedups it, which is acceptable).

## PR 1 — #53 idempotency (ships first)

- New module `src/jobs.ts`: registry + `dispatch` + `fingerprintRequest` +
  `annotateReused` + `__resetJobRegistry` (test-only).
- Add optional `idempotency_key` param to all four generation tools
  (`gemini_generate_image`, `gemini_edit_image`, `gemini_generate_set`,
  `gemini_interact`); route each handler body through `dispatch` (sync path
  only — no `async` yet).
- Result meta gains `reused: true` + `reused_job_id` when served from an existing
  job.
- `Closes #53`.

## PR 2 — #52 async (stacked on PR 1)

- Add `async: true` boolean param to the four tools → returns
  `{ job_id, status: 'running' }` immediately.
- New tool `gemini_get_result` (`src/tools/jobs.ts`, `registerJobTools`): input
  `{ job_id }`; `running` → status text; `done` → the stored result payload;
  `failed` → `McpToolError(message, { hint })`; unknown/evicted → actionable
  `McpToolError` ("job expired or wrong id; jobs are per-process + TTL'd — check
  the output dir"). Read-style (`readOnlyHint: true`, no paid call). Tool count
  5 → 6.
- **Deferred (YAGNI):** the `<name>.partial`-rename completion marker — the poll
  tool + `gemini_interact`'s existing sidecar already make completion
  detectable.
- `Closes #52`.

## Error handling

- Failed jobs record `status: 'failed'` + `{ message, hint }`; surfaced by
  `get_result`. Sync-path failures propagate exactly as today.
- Dedup + async interplay: an `async` call whose `idempotency_key` matches a
  running job returns that job's id (attach), so the caller polls the one job.

## Testing (TDD)

- `tests/jobs.test.ts`: register / in-flight fingerprint dedup / key-for-done /
  TTL + max eviction / reset; `dispatch` sync + async + reuse annotation;
  `fingerprintRequest` stability (same args → same hash; seed/output excluded).
- Per-tool (mocked `client`): two concurrent identical calls → `client.generate`
  fires **once** and the second result carries `reused: true`; `async: true`
  returns a `job_id`; `gemini_get_result` polls `running` → `done`.
- Docs: CLAUDE.md tool table + 5→6 count, README. `version-sync` / `server.json`
  unaffected (tools aren't versioned there).

## Non-goals

- Cross-process / persisted jobs (in-memory only, like `continue_last`).
- Deduping intentional same-prompt variations (explicitly avoided — that's why
  fingerprint dedup is in-flight-only without a key).
- Enriching the host's `-32001` error (client-generated; the async `job_id`
  response is the answer instead).
