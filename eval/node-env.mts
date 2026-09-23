/**
 * CoreEnv for running DocCloak detection in Node (evaluation harness only).
 *
 * Mirrors the web host's env (DocCloak/src/engine-env.web.ts) with Node
 * substitutes: in-memory KV, a disk-backed blob cache under eval/data/models/
 * so the ~46 MB GLiNER model downloads once, global fetch, and the tokenizer
 * loaded from the web app's @huggingface/transformers install (the Core
 * package deliberately does not depend on it).
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { CoreEnv, KVStore, BlobCache } from '../src/env.ts';
import { memoryKV } from '../src/env.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_CACHE_DIR = join(HERE, 'data', 'models');

/**
 * Blobs served by the disk cache, mapped back to their backing file path.
 *
 * Why: the providers hand ONNX Runtime a URL.createObjectURL(blob) string.
 * onnxruntime-web's Node build treats that string as a file path
 * (fs.readFile), so blob: URLs fail with ENOENT. Every model blob the
 * provider ever passes to createObjectURL comes out of BlobCache.match
 * (model-loader.ts prefers the cached copy even right after a download), so
 * remembering blob -> path here and patching createObjectURL to return the
 * path is a complete fix at harness level, with zero changes to src/.
 */
const blobFilePaths = new WeakMap<Blob, string>();

/** Patch URL.createObjectURL to return the backing file path for cache-served blobs. */
export function installNodeBlobUrlShim(): void {
  const origCreate = URL.createObjectURL?.bind(URL);
  const origRevoke = URL.revokeObjectURL?.bind(URL);
  URL.createObjectURL = ((obj: Blob) => {
    const path = blobFilePaths.get(obj);
    // ort 1.29 (webgpu entry) fetch()es the model URL instead of fs-reading
    // it, so hand out a file:// URL and teach fetch to serve it below.
    if (path) return pathToFileURL(path).href;
    return origCreate ? origCreate(obj as never) : `blob:unsupported`;
  }) as typeof URL.createObjectURL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith('file://')) {
      const buf = readFileSync(fileURLToPath(u));
      return new Response(new Uint8Array(buf), { status: 200, headers: { 'Content-Length': String(buf.length) } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
  URL.revokeObjectURL = ((url: string) => {
    if (url.startsWith('blob:') && origRevoke) origRevoke(url);
    // File paths: nothing to revoke; the disk cache owns the file.
  }) as typeof URL.revokeObjectURL;
}

/** Disk-backed BlobCache: one file per URL (SHA-256 of the URL as filename). */
function diskBlobCache(dir: string): BlobCache {
  mkdirSync(dir, { recursive: true });
  const fileFor = (url: string) => join(dir, createHash('sha256').update(url).digest('hex'));
  return {
    async match(url: string): Promise<Blob | undefined> {
      const f = fileFor(url);
      if (!existsSync(f)) return undefined;
      const blob = new Blob([readFileSync(f)]);
      blobFilePaths.set(blob, f);
      return blob;
    },
    async put(url: string, blob: Blob): Promise<boolean> {
      const f = fileFor(url);
      writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
      blobFilePaths.set(blob, f);
      return true;
    },
    async delete(url: string): Promise<void> {
      rmSync(fileFor(url), { force: true });
    },
  };
}

/**
 * Tokenizer via the web app's @huggingface/transformers install. Imported by
 * absolute file URL because eval/ must not add dependencies to Core's
 * package.json (the published package stays tokenizer-free by design).
 */
const TRANSFORMERS_ENTRY = join(
  HERE, '..', '..', 'DocCloak', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs',
);

async function loadTokenizer(hfModelId: string): Promise<unknown> {
  const mod = await import(pathToFileURL(TRANSFORMERS_ENTRY).href);
  const { AutoTokenizer, env: hfEnv } = mod as {
    AutoTokenizer: { from_pretrained(id: string): Promise<unknown> };
    env: { allowLocalModels: boolean; allowRemoteModels: boolean; cacheDir?: string; useFSCache?: boolean };
  };
  hfEnv.allowLocalModels = false;
  hfEnv.allowRemoteModels = true;
  if ('cacheDir' in hfEnv) hfEnv.cacheDir = join(MODEL_CACHE_DIR, 'hf-cache');
  return AutoTokenizer.from_pretrained(hfModelId);
}

export function createNodeEvalEnv(): CoreEnv {
  const kv: KVStore = memoryKV();
  return {
    kv,
    modelCache: diskBlobCache(MODEL_CACHE_DIR),
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    // ort.node.min.mjs resolves its .wasm relative to the package dist dir;
    // point wasmPaths there explicitly so cwd never matters.
    wasm: { paths: join(HERE, '..', 'node_modules', 'onnxruntime-web', 'dist') + '/', numThreads: 1 },
    loadTokenizer,
    hardware: { isMobile: false, deviceMemoryGB: 16 },
  };
}
