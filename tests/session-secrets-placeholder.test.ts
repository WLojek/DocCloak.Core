import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';

// T099/T116 integration: credentials must never get realistic stand-ins,
// even in surrogate mode - a same-shape fake key still reads as a live
// credential. They always fall back to typed placeholders.
describe('surrogate mode placeholder-only types', () => {
  it('gives SECRET a typed placeholder in surrogate mode', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'test' });
    const p = session.anonymize('-----BEGIN RSA PRIVATE KEY-----', 'SECRET');
    expect(p).toBe('[SECRET_1]');
  });

  it('gives API_KEY a typed placeholder in surrogate mode', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'test' });
    const p = session.anonymize('AKIAIOSFODNN7EXAMPLE', 'API_KEY');
    expect(p).toBe('[API_KEY_1]');
  });

  it('still restores the original from the typed placeholder', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'test' });
    session.anonymize('AKIAIOSFODNN7EXAMPLE', 'API_KEY');
    expect(session.deanonymize('use [API_KEY_1] here')).toBe(
      'use AKIAIOSFODNN7EXAMPLE here'
    );
  });

  it('keeps realistic surrogates for non-credential types', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'test' });
    const p = session.anonymize('John Smith', 'PERSON');
    expect(p).not.toMatch(/^\[PERSON_\d+\]$/);
  });
});
