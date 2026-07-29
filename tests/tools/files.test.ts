import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerFileTools } from '../../src/tools/files.js';
import { SessionState } from '../../src/session.js';
import { createDiskSink, createR2Sink } from '../../src/storage/media.js';
import type { GeminiClient } from '../../src/client.js';

/**
 * The Files API tools exist so a caller can hand over a picture ONCE and then
 * refer to it by a 20-character string. Everything here is about that promise:
 * an upload never needs base64 unless you insist, the reference comes back in
 * the form the image tools document, and deleting is gated because it is the
 * one irreversible thing in the group.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function stub(methods: Record<string, unknown> = {}, onDisk = true): GeminiClient {
  return {
    mediaSink: onDisk ? createDiskSink() : createR2Sink({ put: async () => ({}) }, {}),
    session: new SessionState(),
    ...methods,
  } as unknown as GeminiClient;
}

function uploaded(name = 'files/abc123') {
  return {
    name,
    uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
    mimeType: 'image/png',
    sizeBytes: '68',
    displayName: 'photo.png',
    expirationTime: '2026-07-30T12:00:00Z',
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-files-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_upload_file — url', () => {
  it('fetches the URL server-side and returns a reusable files/<id> reference', async () => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'image/png', size: PNG_BYTES.byteLength,
      finalUrl: 'https://cdn.example.com/photo.png', requestedUrl: 'https://cdn.example.com/photo.png',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_upload_file', { url: 'https://cdn.example.com/photo.png' }),
    );
    await h.close();

    expect(fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/photo.png', expect.objectContaining({ accept: expect.arrayContaining(['image/', 'video/']) }));
    // The `files/<id>` form leads, because that is what images_file_uris documents.
    expect(body.file_uri).toBe('files/abc123');
    expect(body.uri).toBe('https://generativelanguage.googleapis.com/v1beta/files/abc123');
    expect(body.mime_type).toBe('image/png');
    expect(body.expires).toBe('2026-07-30T12:00:00Z');
    expect(String(body.hint)).toMatch(/images_file_uris/);
    expect(String(body.hint)).toMatch(/~48h/);
    // Names the upload after the URL's last segment.
    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'photo.png');
  });

  it('honours mime_type and display_name overrides', async () => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'application/octet-stream', size: 4, finalUrl: 'https://x/y', requestedUrl: 'https://x/y',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    await h.callTool('gemini_upload_file', { url: 'https://x/y', mime_type: 'image/webp', display_name: 'hero' });
    await h.close();

    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/webp', 'hero');
  });

  it('surfaces a fetch failure with the URL rather than a generic upload error', async () => {
    const fetchRemoteImage = vi.fn().mockRejectedValue(new Error('https://x/y.png returned HTTP 404'));
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes: vi.fn() })));
    const res = await h.callTool('gemini_upload_file', { url: 'https://x/y.png' });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/y\.png returned HTTP 404/);
  });
});

describe('gemini_upload_file — data_base64 and path', () => {
  it('accepts data_base64 (the last resort) and sniffs its MIME', async () => {
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes })));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_upload_file', { data_base64: PNG_B64 }));
    await h.close();

    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'upload');
    expect(body.file_uri).toBe('files/abc123');
  });

  it('uploads a local path once confirmed, and dry-runs first without confirm', async () => {
    const p = join(dir, 'local.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes })));

    // A prompt-injected `path` would otherwise ship an arbitrary local file to
    // Google, so the dry-run must show the resolved path and upload nothing.
    const preview = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_upload_file', { path: p }));
    expect(preview.dryRun).toBe(true);
    expect(JSON.stringify(preview.willSend)).toContain(p);
    expect(uploadBytes).not.toHaveBeenCalled();

    await h.callTool('gemini_upload_file', { path: p, confirm: true });
    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'local.png');
    await h.close();
  });

  it('refuses `path` on the hosted connector and points at the three alternatives', async () => {
    const uploadBytes = vi.fn();
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes }, false)));
    const res = await h.callTool('gemini_upload_file', { path: '/etc/passwd', confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/no filesystem/);
    expect(text).toMatch(/url/);
    expect(text).toMatch(/\/upload/);
    expect(uploadBytes).not.toHaveBeenCalled();
  });
});

describe('gemini_upload_file — source validation', () => {
  it('requires exactly one source', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes: vi.fn() })));

    const none = await h.callTool('gemini_upload_file', {});
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toMatch(/exactly one/);

    const both = await h.callTool('gemini_upload_file', { url: 'https://x/y.png', data_base64: PNG_B64 });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toMatch(/not 2/);
    await h.close();
  });
});

describe('gemini_list_files', () => {
  it('lists uploads with their references and expiry', async () => {
    const listFiles = vi.fn().mockResolvedValue([
      { name: 'files/a1', uri: 'https://g/v1beta/files/a1', mimeType: 'image/png', state: 'ACTIVE', sizeBytes: '1234', expirationTime: '2026-07-30T12:00:00Z' },
    ]);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles })));
    const body = parseToolResult<{ count: number; files: Array<Record<string, unknown>>; hint: string }>(
      await h.callTool('gemini_list_files', {}),
    );
    await h.close();

    expect(listFiles).toHaveBeenCalledWith(100);
    expect(body.count).toBe(1);
    expect(body.files[0]).toMatchObject({ file_uri: 'files/a1', mime_type: 'image/png', size_bytes: 1234 });
    expect(body.hint).toMatch(/images_file_uris/);
  });

  it('explains an empty list as expiry rather than failure', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles: vi.fn().mockResolvedValue([]) })));
    const body = parseToolResult<{ hint: string }>(await h.callTool('gemini_list_files', {}));
    await h.close();
    expect(body.hint).toMatch(/expired/);
  });

  it('passes page_size through', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles })));
    await h.callTool('gemini_list_files', { page_size: 5 });
    await h.close();
    expect(listFiles).toHaveBeenCalledWith(5);
  });
});

describe('gemini_delete_file', () => {
  it('dry-runs without confirm and deletes nothing', async () => {
    const deleteFile = vi.fn();
    const h = await createTestHarness((s) => registerFileTools(s, stub({ deleteFile })));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_delete_file', { file_uri: 'files/a1' }));
    await h.close();

    expect(body.dryRun).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('deletes when confirmed', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ deleteFile })));
    const body = parseToolResult<{ deleted: string }>(await h.callTool('gemini_delete_file', { file_uri: 'files/a1', confirm: true }));
    await h.close();

    expect(deleteFile).toHaveBeenCalledWith('files/a1');
    expect(body.deleted).toBe('files/a1');
  });
});
