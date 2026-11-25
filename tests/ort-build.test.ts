/**
 * T289: which build of ONNX Runtime a provider loads.
 *
 * The WebGPU build (`onnxruntime-web/webgpu`, the asyncify binary) made Safari's process hold 6 GB
 * as soon as a session existed, and grow on with nothing running; the plain build
 * (`onnxruntime-web/wasm`) holds 1.3 GB flat with the same model and gives the same output. So a
 * provider that runs on the WASM execution provider must import the plain build, and only the two
 * that can run on WebGPU may import the WebGPU build, choosing by execution provider.
 *
 * Read from the sources on purpose: with the library mocked, both entries are the same object, and
 * the difference only exists in a real browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (name: string): string => readFileSync(join(__dirname, '..', 'src', 'providers', `${name}.ts`), 'utf8');
const imports = (text: string): string[] => [...text.matchAll(/^import [^;]*? from '(onnxruntime-web[^']*)';/gm)].map((m) => m[1]);

describe('ONNX Runtime build per provider', () => {
  it.each(['gliner', 'gliner-base', 'bardsai', 'gliner2'])('%s runs on WASM only and loads the plain build', (name) => {
    const text = source(name);
    expect(imports(text)).toEqual(['onnxruntime-web/wasm']);
    expect(text).not.toContain("'webgpu'");
  });

  it.each(['bardsai-v2', 'openai-privacy-filter'])('%s can run on WebGPU and picks the build by execution provider', (name) => {
    const text = source(name);
    expect(new Set(imports(text))).toEqual(new Set(['onnxruntime-web/wasm', 'onnxruntime-web/webgpu']));
    // No session, tensor or setting is taken from a build directly: everything goes through ortFor.
    expect(text).toMatch(/function ortFor\(executionProvider: 'wasm' \| 'webgpu'\)/);
    expect(text).not.toMatch(/ort(Wasm|WebGpu)\.(env|InferenceSession|Tensor)/);
    expect(text.match(/const ort = ortFor\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('no provider is left on the bare package entry', () => {
    for (const name of ['gliner', 'gliner-base', 'bardsai', 'bardsai-v2', 'gliner2', 'openai-privacy-filter']) {
      expect(imports(source(name)), name).not.toContain('onnxruntime-web');
    }
  });
});
