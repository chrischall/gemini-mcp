# Deploying the Gemini connector (Cloudflare Worker)

Operator runbook for the **remote** MCP connector — the Cloudflare Worker that
serves gemini-mcp over HTTP to claude.ai, as opposed to the stdio server you run
locally.

> **Deploy is MANUAL.** There is no CI deploy job and there should not be one:
> this is a personal, single-account connector, not a fleet artifact. Nothing in
> `.github/workflows/` touches Cloudflare. Merging to `main` publishes the npm
> package and the MCP Registry entry; it does **not** update the Worker. If you
> want the deployed connector to reflect `main`, run `npm run worker:deploy`
> yourself.
>
> For the same reason the connector is **not** listed under `remotes` in
> `server.json` — a personal deploy is not a registry-advertised endpoint.

| | |
| --- | --- |
| Worker name | `gemini-connector` |
| Custom domain | `connector.gemini.nullnet.app` |
| Entry point | `src/worker.ts` (compiled by wrangler, excluded from the `tsc` build) |
| Config | `wrangler.jsonc` |
| MCP endpoint | `https://connector.gemini.nullnet.app/mcp` (streamable HTTP; `/sse` also served) |

## What the connector serves

Six of the seven stdio registrars, i.e. every tool except **`gemini_video_generate`**.

That omission is not an oversight and should not be "fixed": MCP defines no
inline **video** content block, so `emitMedia` always writes video output to a
filesystem — and a Worker has none. Registering the tool would advertise
something that cannot return its result. Audio *does* have an inline MCP block,
so `gemini_music_generate` is served.

For the same reason, three **inputs** are unavailable and fail with an explicit
"unavailable on the hosted connector" error rather than a crash:

| Unavailable | Why | Use instead |
| --- | --- | --- |
| `images` / `master_images` | local file paths, read with `node:fs` | `images_base64` |
| `from_clipboard` | shells out to `osascript`/`sips` | `images_base64` |
| `video_path` | Files API upload streams the file off disk | `video_url` |

There is also no `<image>.json` sidecar and no `output_dir`, so the chain
recoveries that read them are skipped. Capture `interaction_id` from each result
to chain turns; the result payload says so rather than pointing at a sidecar
that was never written.

## 1. Authenticate wrangler

```bash
npx wrangler login          # browser OAuth, easiest for an interactive machine
npx wrangler whoami         # confirm the right account
```

For a headless machine use an API token instead:

```bash
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account id>
```

The token needs at minimum:

- **Workers Scripts: Edit** — deploy the script and its Durable Object.
- **Workers KV Storage: Edit** — the OAuth provider reads/writes `OAUTH_KV`.
- **Workers R2 Storage: Edit** — only if you let wrangler create the R2 bucket
  (step 3). Not needed for deploys once the bucket exists.

A token missing Workers KV Storage:Edit deploys "successfully" and then fails at
runtime on the first OAuth handshake — check the binding scopes, not the code.

## 2. KV namespace — already exists, do not re-create

The OAuth token store already lives in this namespace:

```
id: 86a316eabcf342a899a624583db6576a
```

It is hardcoded in `wrangler.jsonc` under the binding name **`OAUTH_KV`**.

**That binding name is not a style choice.** `@cloudflare/workers-oauth-provider`
looks up `env.OAUTH_KV` by name; rename the binding and every OAuth flow breaks
with a confusing runtime error. Leave it alone.

Creating a *second* namespace would silently orphan every existing grant (users
would have to re-authorize), so only run `wrangler kv namespace create` if you
are deliberately starting over — and then update the id above.

## 3. Create the R2 bucket

A Worker has no filesystem, so generated images/video/audio are written to R2 and
handed back to the client as URLs instead of local paths. The bucket is bound as
`MEDIA_BUCKET`. Create it once per account:

```bash
wrangler r2 bucket create gemini-connector-media
```

Already exists? The command errors and that is fine — nothing to do.

## 4. Set secrets

Local dev reads `.dev.vars` (copy `.dev.vars.example`, gitignored). The deployed
Worker reads secrets, which are set separately and are **not** in `wrangler.jsonc`:

```bash
wrangler secret list
```

**There is no `GEMINI_API_KEY` secret on this Worker.** Each user supplies their
own key on the connector's login page (`/authorize`); it is verified with a
`GET /v1beta/models` call and then stored by the OAuth provider in `OAUTH_KV`,
and `buildClient` turns it back into one `GeminiClient` **per authenticated
session**. A server-wide key would bill every user's generations to one account.
(`.dev.vars` still carries one for `wrangler dev` convenience; nothing reads it
in the request path.)

`GEMINI_OUTPUT_DIR` / `GEMINI_INPUT_DIR` have no meaning here — there is no disk.

### Optional: serve the media bucket publicly

Generated media goes to `MEDIA_BUCKET`. To have results come back as fetchable
URLs, expose the bucket (R2 public dev URL, or a custom domain) and tell the
Worker its base:

```bash
wrangler secret put MEDIA_PUBLIC_BASE_URL     # e.g. https://media.gemini.nullnet.app
```

Leave it unset and nothing breaks: media is still stored, but results report
honest `r2://gemini-connector-media/<key>` object refs and say plainly that they
are not publicly fetchable — rather than handing back an https URL that 404s.
Callers who just want the bytes can pass `inline: true` either way.

## 5. Deploy

```bash
npm run worker:deploy      # wrangler deploy
```

Local iteration:

```bash
npm run worker:dev         # wrangler dev
npm run worker:test        # tsc -p tsconfig.worker.json, then the workerd pool
```

`npm test` runs the **Node** suite only; `tests/worker*.test.ts` is excluded
there because worker sources import `cloudflare:workers` / `agents`, which cannot
load outside workerd. Run both before deploying.

Neither wrangler nor the vitest pool checks types, so `worker:test` runs
`worker:typecheck` first — that is the only thing that typechecks `src/worker.ts`.
Binding types live in `worker-env.d.ts` (merged into `Cloudflare.Env`); keep it in
step with the bindings in `wrangler.jsonc`.

`src/worker.ts` is the real connector: `createConnector` from
`@chrischall/mcp-connector` wires `src/gemini-auth.ts` (the login form + key
verification) to an `agents` McpAgent behind
@cloudflare/workers-oauth-provider, exported as the `GeminiMcpAgent` Durable
Object that migration `v1` names.

## 6. The custom domain is not ready the moment deploy finishes

`wrangler deploy` attaches `connector.gemini.nullnet.app` and returns, but
Cloudflare then provisions the TLS certificate **asynchronously — typically a
few minutes afterwards**. Until it lands, requests to the custom domain fail with
a TLS/handshake error (or a 525/526), which looks exactly like a broken deploy
and is not one.

Use the `*.workers.dev` URL that `wrangler deploy` prints to verify the deploy
immediately, and re-check the custom domain a few minutes later. The OAuth
discovery document is the probe — the connector serves no health route (every
path but `/authorize`, `/token`, `/register`, `/mcp` and `/sse` is a 404):

```bash
curl -sS https://gemini-connector.<subdomain>.workers.dev/.well-known/oauth-authorization-server
curl -sSI https://connector.gemini.nullnet.app/.well-known/oauth-authorization-server
```

Do not redeploy in response to that first TLS error — redeploying does not speed
up certificate issuance.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| TLS failure on the custom domain right after deploy | Cert still provisioning — wait a few minutes, use the workers.dev URL |
| OAuth handshake 500s | `OAUTH_KV` binding renamed/missing, or token lacks Workers KV Storage:Edit |
| Media generation errors about missing storage | `gemini-connector-media` bucket not created (step 3) |
| Upstream 429 with `limit: 0` | Free-tier key hitting a paid model — fund the Google account; not a throttle |
| DO class errors on first deploy | `migrations` tag `v1` / `new_sqlite_classes` edited — never rewrite a shipped migration tag |
| `/` or `/health` returns 404 | Expected — the connector serves only the OAuth + MCP routes; probe `/.well-known/oauth-authorization-server` |
| Login page rejects a valid-looking key | The key is verified with a live `GET /v1beta/models`; the upstream message is shown verbatim |
| Results are `r2://…` refs, not URLs | `MEDIA_PUBLIC_BASE_URL` is unset — see step 4, or pass `inline: true` |
| `gemini_video_generate` missing from tools/list | Intentional and permanent: MCP has no inline video block and a Worker has no disk |
| Deploy fails with code 10021 (`'path' argument must be of type string`) | A module-scope `fileURLToPath(import.meta.url)` — `import.meta.url` is undefined in a deployed Worker. Neither `--dry-run` nor the test pool catches it |
