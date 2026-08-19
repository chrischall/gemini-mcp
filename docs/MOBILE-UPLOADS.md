# Getting a photo in from a phone

**Status: investigated 2026-08-18, nothing implemented.** This file records why
`gemini_get_upload_url` does not help a Claude mobile user, what was ruled out
and on what evidence, and which routes are actually open — so the next person
asking "surely the phone can just upload it?" starts from the findings instead
of the question.

## The problem

`gemini_get_upload_url` mints a short-lived signed `PUT` and hands back a curl
line. That closes the byte gap for anyone holding a shell. The Claude mobile app
is not that: no shell, no curl, no filesystem the connector can name. The one
thing a phone has in abundance — a camera roll — is the one thing there is no
route for.

Everything below is about the **hosted** deployment. On stdio the question does
not arise: `images` reads local paths directly.

## What is ruled out, and why

### MCP has no file channel from client to server

Checked against the SDK vendored here, not from memory:

- **Tool arguments are model-authored JSON.** Claude cannot emit the bytes of a
  photo it is looking at — an attached image reaches the model as vision tokens,
  not a buffer it can re-serialize. `images_base64` is therefore only usable by
  a caller that can *read a file*, which on mobile is nobody.
- **Form elicitation is primitive-typed only.** `PrimitiveSchemaDefinitionSchema`
  (`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:1727`) is a union of
  enum / boolean / string / number. There is no file member, so
  `elicitation/create` in form mode cannot ask for one.
- **Resources and sampling both flow server→client.** Neither carries user files
  the other way.

### The protocol's own answer is a URL

`ElicitRequestURLParamsSchema` (same file, line 1755) is `mode: 'url'` plus a
`message`, an `elicitationId` and a `url`; the client navigates the user there
and later sends `notifications/elicitation/complete`. This exists precisely for
work the wire cannot carry. So "hand the user a web page" is not a failure of
imagination — it is the designed escape hatch, and it is a client-opened sheet
rather than a raw link the user has to juggle.

Whether claude.ai's connector client implements URL-mode elicitation is
**unverified**. If it does not, the fallback is printing the link in the tool
result, which is strictly worse UX but still works.

### The blob store cannot host the upload page

Two independent blockers in mcp-host's gateway (`packages/gateway/src/blob.ts`):

- **Stored objects are served un-runnable.** `content-security-policy:
  default-src 'none'; sandbox` plus `x-content-type-options: nosniff` (line 198).
  An HTML page PUT into the bucket would render as a dead document — no scripts,
  so no file picker and no `fetch`.
- **No CORS, and no preflight to have any.** The route accepts exactly
  `GET/HEAD/PUT/DELETE` and 405s everything else (line 101), and sends no
  `Access-Control-*` headers on any of them. `PUT` is never a simple request, so
  a page on *any other origin* cannot preflight it.

Between them: the page cannot live in the store, and it cannot live anywhere
else either, unless mcp-host changes. That is the whole reason this is not a
gemini-mcp-only fix.

## What is actually open

Ordered by what it costs to ship, cheapest first.

### 1. An iOS Shortcut from the share sheet — no server change at all

The signed `PUT` URL this repo already mints is usable by anything that speaks
HTTP, and Shortcuts speaks HTTP. *Convert Image* handles HEIC→JPEG so the bytes
match the content type the signature covers, *Resize Image* keeps it under
`UPLOAD_MAX_BYTES` (15 MB), and *Get Contents of URL* does method `PUT`, custom
headers, and Request Body = File.

Flow: mint the URL → user copies it → share a photo → "Send to Gemini" → done.
The `r2_key` is known at mint time (see the header comment in
`src/tools/uploads.ts`), so nothing has to come back from the phone; Claude uses
the key it already holds.

Costs a one-time Shortcut install, and answers the constraint literally — no
browser anywhere in it. **The Shortcut actions above are unverified on a
device.** Android's equivalents (HTTP Shortcuts, Tasker) are real but clunkier
and would need their own recipe.

### 2. URL-mode elicitation pointing at a page mcp-host serves

Add an HTML upload page to the blob route itself — something like
`GET /b/<registrationId>/<key>?ct=&exp=&sig=&form=1`, verified against the same
write signature before it renders, PUTting **same-origin** so no CORS question
arises. The page normalizes the picked image (canvas → JPEG, ≤2048px) so the
signed content type always matches and the size cap always holds. mcp-host
already has an HTML-page tradition to build on (`src/page-tokens.ts`, the
`/authorize` and `/app/auth` pages).

gemini-mcp's side is small: emit the page URL from `gemini_get_upload_url`, and
raise it through URL elicitation where the client supports it.

Zero install for the user. Cross-repo, and it is a browser.

### 3. ContextMint claims the path as a universal link

`mcp-host/packages/gateway/src/app-links.ts` already binds `/app/auth` to the
app for exactly this kind of hand-off, and deliberately lists paths exactly
rather than by wildcard. Adding the upload path means one URL that opens a
**native photo picker** when the app is installed and falls back to (2) in a
browser sheet when it is not — the best end state, and the reason (2) is worth
building even though it is a browser.

Blocked on the app: `mcp-host-app` is mid-M4a with CI red on contract codegen,
and it is an operator/admin client today, not a place a photo naturally goes.

### 4. Already-hosted photos work now

`images_url` takes any public https URL and the server fetches it
(`src/fetch-image.ts`). For a photo that already lives somewhere linkable this
needs nothing new — it just does not cover the camera roll.

## The recommendation on file

Ship (1) first: it is the only option with no cross-repo dependency and it
answers the constraint as stated. Then (2) as the zero-install fallback, shaped
so (3) can claim the same URL later without moving it.
