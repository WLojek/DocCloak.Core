import { describe, expect, it } from 'vitest';
import { memoryBlobCache, memoryKV } from '../src/env.ts';

describe('memoryKV', () => {
  it('round-trips get/set/remove', async () => {
    const kv = memoryKV();

    expect(await kv.get('missing')).toBeNull();

    await kv.set('provider', 'gliner');
    expect(await kv.get('provider')).toBe('gliner');

    await kv.set('provider', 'bardsai');
    expect(await kv.get('provider')).toBe('bardsai');

    await kv.remove('provider');
    expect(await kv.get('provider')).toBeNull();
  });

  it('stores empty strings distinctly from missing keys', async () => {
    const kv = memoryKV();
    await kv.set('empty', '');
    expect(await kv.get('empty')).toBe('');
  });

  it('isolates instances from each other', async () => {
    const a = memoryKV();
    const b = memoryKV();
    await a.set('key', 'value');
    expect(await b.get('key')).toBeNull();
  });
});

describe('memoryBlobCache', () => {
  it('supports match/put/delete', async () => {
    const cache = memoryBlobCache();
    const url = 'https://models.example/model.onnx';
    const blob = new Blob(['model-bytes']);

    expect(await cache.match(url)).toBeUndefined();

    expect(await cache.put(url, blob)).toBe(true);
    const hit = await cache.match(url);
    expect(hit).toBeDefined();
    expect(await hit!.text()).toBe('model-bytes');

    await cache.delete(url);
    expect(await cache.match(url)).toBeUndefined();
  });

  it('overwrites an existing entry for the same url', async () => {
    const cache = memoryBlobCache();
    const url = 'https://models.example/tokenizer.json';

    expect(await cache.put(url, new Blob(['v1']))).toBe(true);
    expect(await cache.put(url, new Blob(['v2']))).toBe(true);
    expect(await (await cache.match(url))!.text()).toBe('v2');
  });

  it('returns false when a put would exceed the quota and leaves the entry unstored', async () => {
    const cache = memoryBlobCache({ maxBytes: 10 });

    expect(await cache.put('a', new Blob(['12345678']))).toBe(true); // 8 bytes
    expect(await cache.put('b', new Blob(['123456']))).toBe(false);  // 8 + 6 > 10
    expect(await cache.match('b')).toBeUndefined();

    // The earlier entry is untouched by the refused put.
    expect(await (await cache.match('a'))!.text()).toBe('12345678');

    // Freeing space makes the put succeed.
    await cache.delete('a');
    expect(await cache.put('b', new Blob(['123456']))).toBe(true);
  });

  it('counts replacement puts against the quota using the size delta', async () => {
    const cache = memoryBlobCache({ maxBytes: 10 });

    expect(await cache.put('a', new Blob(['123456789']))).toBe(true);  // 9 bytes
    // Replacing a 9-byte blob with a 10-byte blob fits exactly.
    expect(await cache.put('a', new Blob(['1234567890']))).toBe(true);
    // Replacing with an 11-byte blob does not.
    expect(await cache.put('a', new Blob(['12345678901']))).toBe(false);
    expect(await (await cache.match('a'))!.text()).toBe('1234567890');
  });
});
