# Changelog

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
