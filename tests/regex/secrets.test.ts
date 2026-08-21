/**
 * T099 secrets/API-key detection tier tests.
 *
 * Positive cases for every shipped secret pattern, plus the negative
 * corpus the entropy gate must reject (ordinary prose, UUIDs, git SHAs,
 * base64 image data, identifiers, placeholder config values). The
 * Shannon threshold reasoning is documented by the entropy tests at the
 * bottom: the numbers asserted there are the measurements the 3.0 (hex),
 * 4.0 (mixed assignment values) and 4.5 (bare tokens) cutoffs were
 * tuned against.
 */
import { describe, it, expect } from 'vitest';
import { shannonEntropy } from '../../src/regex/validators.ts';
import { detectWithRegex } from '../../src/pipeline.ts';

const SECRET_TYPES = new Set(['SECRET', 'API_KEY']);

/** All SECRET/API_KEY detections for a text, via the real pipeline entry. */
function detectSecrets(text: string, region = 'all') {
  return detectWithRegex(text, region).filter((e) => SECRET_TYPES.has(e.type));
}

function detectors(text: string): string[] {
  return detectSecrets(text).map((e) => e.detector);
}

// ── Named vendor patterns (no entropy gate needed) ──────────

describe('secrets tier: named vendor patterns', () => {
  it('detects AWS access key IDs in prose', () => {
    const found = detectSecrets('the key AKIAIOSFODNN7EXAMPLE leaked in the log');
    expect(found.some((e) => e.detector === 'regex:universal:aws_access_key')).toBe(true);
    expect(found.find((e) => e.detector === 'regex:universal:aws_access_key')?.type).toBe('API_KEY');
    expect(found.find((e) => e.detector === 'regex:universal:aws_access_key')?.value).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('detects classic and fine-grained GitHub tokens', () => {
    expect(detectors('token ghp_16C7e42F292c6912E7710c838347Ae178B4a here'))
      .toContain('regex:universal:github_token');
    expect(detectors('github_pat_11ABCDEFG0123456789abc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'))
      .toContain('regex:universal:github_token');
  });

  it('detects Slack bot and user tokens', () => {
    expect(detectors('SLACK_TOKEN=xoxb-NotARealBotToken-DocCloakTestFixture'))
      .toContain('regex:universal:slack_token');
    expect(detectors('xoxp-FakeUserToken-DocCloakTestFixture00'))
      .toContain('regex:universal:slack_token');
  });

  it('detects OpenAI keys (legacy and project-scoped)', () => {
    expect(detectors('OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl'))
      .toContain('regex:universal:openai_api_key');
    expect(detectors('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh'))
      .toContain('regex:universal:openai_api_key');
  });

  it('detects Anthropic keys with the anthropic rule, not the OpenAI one', () => {
    const found = detectors('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-AbCdEfGh');
    expect(found).toContain('regex:universal:anthropic_api_key');
    expect(found).not.toContain('regex:universal:openai_api_key');
  });

  it('detects Google API keys', () => {
    expect(detectors('key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'))
      .toContain('regex:universal:google_api_key');
  });

  it('ships in the universal pack, so every region selection gets it', () => {
    expect(detectors('AKIAIOSFODNN7EXAMPLE')).toContain('regex:universal:aws_access_key');
    expect(detectSecrets('AKIAIOSFODNN7EXAMPLE', 'pl').map((e) => e.detector))
      .toContain('regex:universal:aws_access_key');
  });
});

// ── Structured secrets ──────────────────────────────────────

describe('secrets tier: structured secrets', () => {
  it('detects multi-line PEM private key blocks (RSA and OpenSSH)', () => {
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----';
    const ssh = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
    const found = detectSecrets(`config dump:\n${rsa}\nand an ssh key:\n${ssh}`);
    const blocks = found.filter((e) => e.detector === 'regex:universal:private_key_block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].value).toBe(rsa);
    expect(blocks[1].value).toBe(ssh);
  });

  it('detects JWTs (three base64url segments)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const found = detectSecrets(`Authorization: Bearer ${jwt}`);
    expect(found.find((e) => e.detector === 'regex:universal:jwt')?.value).toBe(jwt);
  });

  it('detects connection strings with inline credentials', () => {
    expect(detectors('DATABASE_URL=postgres://admin:S3cr3tPass@db.example.com:5432/mydb'))
      .toContain('regex:universal:connection_string_creds');
    expect(detectors('mongodb+srv://appuser:hunter2pass@cluster0.abc.mongodb.net/prod'))
      .toContain('regex:universal:connection_string_creds');
  });

  it('ignores URLs without a user:password pair', () => {
    expect(detectSecrets('see https://example.com:8080/path?q=1 and http://twitter.com/@user')).toEqual([]);
  });
});

// ── Generic entropy-gated candidates ────────────────────────

describe('secrets tier: keyword assignment with entropy gate', () => {
  it('detects a quoted mixed-charset api key assignment', () => {
    expect(detectors('api_key = "9fQz3kX7Lm2Pw8Rt5Vy1Jh6Nd4Bg0Cs"'))
      .toContain('regex:universal:secret_assignment');
  });

  it('detects an AWS secret access key assignment (keyword inside a longer name)', () => {
    expect(detectors('aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toContain('regex:universal:secret_assignment');
  });

  it('detects a pure-hex session token at the lower hex threshold', () => {
    expect(detectors('session_token=a3f8c2d914b7e605d2c8a1f4b9e7d305'))
      .toContain('regex:universal:secret_assignment');
  });

  it('rejects low-entropy placeholder values', () => {
    expect(detectSecrets('api_key = "your_api_key_here"')).toEqual([]);
    expect(detectSecrets('password: changeme_please_now')).toEqual([]);
    expect(detectSecrets('token = xxxxxxxxxxxxxxxxxxxx')).toEqual([]);
    expect(detectSecrets('api_key = "example_password_123"')).toEqual([]);
  });

  it('rejects UUIDs and pure digits even in assignments', () => {
    expect(detectSecrets('request_token = 550e8400-e29b-41d4-a716-446655440000')).toEqual([]);
    expect(detectSecrets('access_key: 12345678901234567890')).toEqual([]);
  });

  it('ignores keyword mentions without an assignment', () => {
    expect(detectSecrets('The authentication token expired yesterday afternoon')).toEqual([]);
    expect(detectSecrets('rotate the api key and the client secret quarterly')).toEqual([]);
  });
});

describe('secrets tier: bare high-entropy token gate', () => {
  const token43 = 'Zq7PmX2vR9kLtY4wNb8QcJ3fHd6GsA1uEi5oT0xVrKp';

  it('detects bare 40+ char mixed-charset random tokens', () => {
    expect(detectors(`found this in the paste: ${token43}`))
      .toContain('regex:universal:high_entropy_token');
    expect(detectors('kM3nP8qR2sT7uV1wX5yZ9aB4cD6eF0gH1jK2lM3nP4qR5sT6'))
      .toContain('regex:universal:high_entropy_token');
  });

  it('rejects git SHAs (single-case hex)', () => {
    expect(detectSecrets('commit 3f5a12b9cde034f1a7b2c8d9e0f1a2b3c4d5e6f7 fixed it')).toEqual([]);
    expect(detectSecrets('3f5a12b9cde034f1a7b2c8d9e0f1a2b3c4d5e6f7')).toEqual([]);
  });

  it('rejects UUIDs (hyphens split them below the length floor)', () => {
    expect(detectSecrets('id 550e8400-e29b-41d4-a716-446655440000 created')).toEqual([]);
  });

  it('rejects base64 image data (contiguous runs beyond the 256 char cap)', () => {
    // High-entropy content, but one contiguous 344 char run: real data
    // blobs (base64 images) look like this, credentials do not.
    const blob = token43.repeat(8);
    expect(detectSecrets(`data:image/png;base64,${blob}`)).toEqual([]);
  });

  it('rejects long identifiers and ordinary prose', () => {
    expect(detectSecrets('getUserAccountDetailsFromDatabaseAsyncOrElse')).toEqual([]);
    expect(detectSecrets('convertBase64ToUtf8String2020FastVersionNext')).toEqual([]);
    expect(detectSecrets(
      'We reviewed the quarterly report together yesterday and agreed to '
      + 'publish the updated onboarding documentation before the deadline.',
    )).toEqual([]);
  });
});

// ── Threshold documentation ─────────────────────────────────
//
// The cutoffs are chosen from these measurements:
//  - random hex (16 hex symbols) tops out at 4.0 bits/char and 32 char
//    keys average ~3.6 with a ~3.0 floor, so hex assignment values pass
//    at >= 3.0 (detect-secrets uses the same hex threshold);
//  - placeholder/config words measure ~3.3-3.9, so non-hex assignment
//    values need >= 4.0;
//  - random 40+ char base64 averages ~4.8 (p1 ~4.5) while camelCase
//    identifiers with digits measure ~4.3, so bare tokens need >= 4.5.

describe('shannonEntropy: measurements behind the thresholds', () => {
  it('is 0 for empty and single-symbol strings', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('xxxxxxxxxxxxxxxx')).toBe(0);
  });

  it('random base64 key material clears the 4.5 bare-token threshold', () => {
    expect(shannonEntropy('Zq7PmX2vR9kLtY4wNb8QcJ3fHd6GsA1uEi5oT0xVrKp')).toBeGreaterThan(4.5);
    expect(shannonEntropy('kM3nP8qR2sT7uV1wX5yZ9aB4cD6eF0gH1jK2lM3nP4qR5sT6')).toBeGreaterThan(4.5);
  });

  it('identifiers with mixed classes stay below the 4.5 bare-token threshold', () => {
    expect(shannonEntropy('convertBase64ToUtf8String2020FastVersionNext')).toBeLessThan(4.5);
    expect(shannonEntropy('getUserAccountDetailsFromDatabaseAsyncOrElse')).toBeLessThan(4.5);
  });

  it('random 32-char hex sits between the 3.0 hex and 4.0 mixed thresholds', () => {
    const hex = 'a3f8c2d914b7e605d2c8a1f4b9e7d305';
    expect(shannonEntropy(hex)).toBeGreaterThan(3.0);
    expect(shannonEntropy(hex)).toBeLessThan(4.0);
  });

  it('placeholder values stay below the 4.0 mixed-value threshold', () => {
    expect(shannonEntropy('your_api_key_here')).toBeLessThan(4.0);
    expect(shannonEntropy('changeme_please_now')).toBeLessThan(4.0);
    expect(shannonEntropy('example_password_123')).toBeLessThan(4.0);
    expect(shannonEntropy('550e8400-e29b-41d4-a716-446655440000')).toBeLessThan(4.0);
  });
});

// ── Rule metadata ───────────────────────────────────────────

describe('secrets tier: rule metadata', () => {
  it('all secrets rules are universal, technical, and typed SECRET or API_KEY', async () => {
    const { ALL_REGEX_RULES } = await import('../../src/regex/index.ts');
    const secretRules = ALL_REGEX_RULES.filter((r) => SECRET_TYPES.has(r.type));
    expect(secretRules).toHaveLength(11);
    for (const rule of secretRules) {
      expect(rule.region).toBe('universal');
      expect(rule.domains).toContain('technical');
    }
  });
});
