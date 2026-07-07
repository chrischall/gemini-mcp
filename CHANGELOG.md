# Changelog

## [0.8.0](https://github.com/chrischall/gemini-mcp/compare/v0.7.2...v0.8.0) (2026-07-07)


### Features

* **timeout:** configurable timeouts, progress heartbeat, and interaction-id sidecar for timeout recovery ([#54](https://github.com/chrischall/gemini-mcp/issues/54)) ([b20edc5](https://github.com/chrischall/gemini-mcp/commit/b20edc56f39c047bedb047373f315f59a2938bb4))


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#58](https://github.com/chrischall/gemini-mcp/issues/58)) ([4a6e828](https://github.com/chrischall/gemini-mcp/commit/4a6e8288e7178814eb79f345c0d476be2b10a959))
* confirm-gate local-file image inputs before upload to Gemini ([#55](https://github.com/chrischall/gemini-mcp/issues/55)) ([e19a152](https://github.com/chrischall/gemini-mcp/commit/e19a15217b542cfac863cacc3d66b5cf45adf76c))
* restore sharedImageSchema JSDoc + order-independent interact-continue test ([#57](https://github.com/chrischall/gemini-mcp/issues/57)) ([816c699](https://github.com/chrischall/gemini-mcp/commit/816c699c82105f96663df9b0f0b1847ac87062a1))


### Documentation

* **claude:** follow-up issues now also open on pass-with-nits ([#49](https://github.com/chrischall/gemini-mcp/issues/49)) ([1d20cea](https://github.com/chrischall/gemini-mcp/commit/1d20cead9f01be0a48c539be072374a58a2cc804))
* document first-party dependency-bump label exception ([#60](https://github.com/chrischall/gemini-mcp/issues/60)) ([4c7abe4](https://github.com/chrischall/gemini-mcp/commit/4c7abe41d9a78b032bdfbffe4bff25eee30c402d))

## [0.7.2](https://github.com/chrischall/gemini-mcp/compare/v0.7.1...v0.7.2) (2026-07-06)


### Bug Fixes

* **images:** always resolve input paths to absolute; drop redundant resolve() calls ([#48](https://github.com/chrischall/gemini-mcp/issues/48)) ([a998545](https://github.com/chrischall/gemini-mcp/commit/a998545150ca1dfe6721ab8ac8506f4ff3e2a947))
* **interact:** drop re-attached prior outputs on chained calls; warn in schema and hint ([#46](https://github.com/chrischall/gemini-mcp/issues/46)) ([f4bdc2d](https://github.com/chrischall/gemini-mcp/commit/f4bdc2d14689d280802fa2da298744a3eff17666))

## [0.7.1](https://github.com/chrischall/gemini-mcp/compare/v0.7.0...v0.7.1) (2026-07-06)


### Bug Fixes

* **client:** retry chained interact 404s — interactions store is eventually consistent ([#44](https://github.com/chrischall/gemini-mcp/issues/44)) ([c2f3a8a](https://github.com/chrischall/gemini-mcp/commit/c2f3a8af051a86c2c184b947ec3597058973a265))

## [0.7.0](https://github.com/chrischall/gemini-mcp/compare/v0.6.1...v0.7.0) (2026-07-06)


### Features

* **interact:** image_search grounding via search_types, plus prompting playbook ([#43](https://github.com/chrischall/gemini-mcp/issues/43)) ([8f82bda](https://github.com/chrischall/gemini-mcp/commit/8f82bda20f76d792a00a8e31937bb32c6bbd6849))
* **tools:** steer iterative edits to gemini_interact, add continue_last, default to gemini-3.1-flash-image ([#39](https://github.com/chrischall/gemini-mcp/issues/39)) ([529b404](https://github.com/chrischall/gemini-mcp/commit/529b404a575b372c10096758b5185baa7689c148))


### Bug Fixes

* **client:** drop obsolete Api-Revision header — Interactions API is GA ([#42](https://github.com/chrischall/gemini-mcp/issues/42)) ([a24fb24](https://github.com/chrischall/gemini-mcp/commit/a24fb24849793558be70397df242b177b6ad432d))

## [0.6.1](https://github.com/chrischall/gemini-mcp/compare/v0.6.0...v0.6.1) (2026-07-05)


### Documentation

* refresh CLAUDE.md and document auto-review follow-up convention ([#29](https://github.com/chrischall/gemini-mcp/issues/29)) ([bc0875c](https://github.com/chrischall/gemini-mcp/commit/bc0875c671f728fcb9ed97f9d69d97b8d38713e1))
* require Conventional Commit PR titles for release-please ([#25](https://github.com/chrischall/gemini-mcp/issues/25)) ([6c222e2](https://github.com/chrischall/gemini-mcp/commit/6c222e2e6d91bb31929f05257c6536477561599d))

## [0.6.0](https://github.com/chrischall/gemini-mcp/compare/v0.5.0...v0.6.0) (2026-06-13)


### Features

* local video input via video_path (Files API upload) for video-to-image ([#22](https://github.com/chrischall/gemini-mcp/issues/22)) ([1daa563](https://github.com/chrischall/gemini-mcp/commit/1daa5637210e884dad8f595ea503260aba765a71)), closes [#8](https://github.com/chrischall/gemini-mcp/issues/8)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally ([#20](https://github.com/chrischall/gemini-mcp/issues/20)) ([d310f5a](https://github.com/chrischall/gemini-mcp/commit/d310f5a8ebe98cbc6a8d047fccd82ea08a93092f))


### Documentation

* add CLAUDE.md ([#16](https://github.com/chrischall/gemini-mcp/issues/16)) ([036836e](https://github.com/chrischall/gemini-mcp/commit/036836e407f9d0dd4ceedc9849bf4ee29f43af33))
* add MIT LICENSE file and README badges ([#18](https://github.com/chrischall/gemini-mcp/issues/18)) ([b91e5bd](https://github.com/chrischall/gemini-mcp/commit/b91e5bde1bb7da5771cf027256942bda5687e1e3))

## [0.5.0](https://github.com/chrischall/gemini-mcp/compare/v0.4.0...v0.5.0) (2026-06-09)


### Features

* migrate both Gemini paths to the shared client (timeout + 429 retry) ([#14](https://github.com/chrischall/gemini-mcp/issues/14)) ([4e87191](https://github.com/chrischall/gemini-mcp/commit/4e8719127a150658570f2e9a21a3c6cfdea76084))

## [0.4.0](https://github.com/chrischall/gemini-mcp/compare/v0.3.0...v0.4.0) (2026-06-08)


### Features

* GEMINI_INPUT_DIR resolution + from_clipboard image ingestion ([#12](https://github.com/chrischall/gemini-mcp/issues/12)) ([aaa761f](https://github.com/chrischall/gemini-mcp/commit/aaa761fafb1a46ea1ba35e77695dbd5743dc78de))


### Documentation

* **skill:** add verified macOS clipboard workaround for reference images ([#11](https://github.com/chrischall/gemini-mcp/issues/11)) ([06ab419](https://github.com/chrischall/gemini-mcp/commit/06ab419c3fc37b82e5d98ba9bca934fcf625195b))
* **skill:** correct chat-pasted-image guidance (bytes aren't reachable) ([#9](https://github.com/chrischall/gemini-mcp/issues/9)) ([e441f87](https://github.com/chrischall/gemini-mcp/commit/e441f878a223ae0d85c892bf887ef7716949effa))

## [0.3.0](https://github.com/chrischall/gemini-mcp/compare/v0.2.0...v0.3.0) (2026-06-08)


### Features

* Google Search grounding + video-to-image ([#7](https://github.com/chrischall/gemini-mcp/issues/7)) ([1b68773](https://github.com/chrischall/gemini-mcp/commit/1b68773712e102a86faf4740b8a04aa51e84df75))
* image input by value, seed, filenames, set references ([#4](https://github.com/chrischall/gemini-mcp/issues/4)) ([09d2844](https://github.com/chrischall/gemini-mcp/commit/09d28445b8384fa9a05a4674e00cc00f981124c5))

## [0.2.0](https://github.com/chrischall/gemini-mcp/compare/v0.1.0...v0.2.0) (2026-06-08)


### Features

* initial gemini-mcp implementation ([#1](https://github.com/chrischall/gemini-mcp/issues/1)) ([a3560d5](https://github.com/chrischall/gemini-mcp/commit/a3560d5205053e88c35f195cdff57d052ef2a15c))


### Documentation

* gemini-mcp design spec ([ee66721](https://github.com/chrischall/gemini-mcp/commit/ee6672193c0350266bcc30dc22107ec65affd773))
* gemini-mcp implementation plan ([4b7fae2](https://github.com/chrischall/gemini-mcp/commit/4b7fae272e9ee3e4bf73b3535e6866c33ec6349c))
