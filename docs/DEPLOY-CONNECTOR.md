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
wrangler secret put GEMINI_API_KEY
wrangler secret list
```

`GEMINI_OUTPUT_DIR` / `GEMINI_INPUT_DIR` have no meaning here — there is no disk.

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

> **`src/worker.ts` is still a placeholder.** It exports the `GeminiMcpAgent`
> Durable Object class that migration `v1` names and answers a health probe, so
> the config is deployable and testable end to end. The real connector — an
> `agents` McpAgent behind @cloudflare/workers-oauth-provider, serving the gemini
> tools with media written to R2 — lands separately. Deploying now gets you a
> reachable Worker that serves no tools.

## 6. The custom domain is not ready the moment deploy finishes

`wrangler deploy` attaches `connector.gemini.nullnet.app` and returns, but
Cloudflare then provisions the TLS certificate **asynchronously — typically a
few minutes afterwards**. Until it lands, requests to the custom domain fail with
a TLS/handshake error (or a 525/526), which looks exactly like a broken deploy
and is not one.

Use the `*.workers.dev` URL that `wrangler deploy` prints to verify the deploy
immediately, and re-check the custom domain a few minutes later:

```bash
curl -sS https://gemini-connector.<subdomain>.workers.dev/  # works right away
curl -sSI https://connector.gemini.nullnet.app/             # works once the cert is issued
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
