/**
 * Validator registry for the shared rules format (T018, arch doc section 6).
 *
 * Every function here was extracted verbatim from a former inline `validate`
 * closure in the TS rule modules; behavior is intentionally identical.
 * The `validate` field in rules/*.json refers to these names, resolved by
 * loader.ts. Python resolves the same names against its own registry
 * (DocCloak.Cli validators.py); where a Python equivalent exists the name
 * matches it: pesel_check -> pesel, nip_check -> nip, nino_check -> nino,
 * luhn_check -> luhn, nir_check -> nir, ipv4_check -> ipOctets.
 */

export type RuleValidator = (match: string) => boolean;

/** Luhn checksum over the digits of the match (credit/debit card numbers). */
function luhn(num: string): boolean {
  const digits = num.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 check (ISO 13616) using chunked arithmetic (BigInt not needed). */
function ibanMod97(match: string): boolean {
  const clean = match.replace(/\s/g, '').toUpperCase();
  if (clean.length < 5 || clean.length > 34) return false;
  // Move first 4 chars to end, convert letters to digits (A=10..Z=35)
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let numStr = '';
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') numStr += ch;
    else numStr += (ch.charCodeAt(0) - 55).toString();
  }
  // Mod-97 using chunked arithmetic (BigInt not needed)
  let remainder = 0;
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + parseInt(numStr[i], 10)) % 97;
  }
  return remainder === 1;
}

/** Every dotted octet of an IPv4 address is in 0-255. */
function ipOctets(ip: string): boolean {
  return ip.split('.').every(octet => {
    const n = parseInt(octet, 10);
    return n >= 0 && n <= 255;
  });
}

/**
 * UK National Insurance Number structural rules (HMRC prefix spec):
 * first letter is never D, F, I, Q, U, V; second letter is never
 * D, F, I, O, Q, U, V; the prefixes BG, GB, NK, KN, TN, NT, ZZ are
 * never allocated. T100 fixed the second-letter class, which was
 * missing V (the Python twin in DocCloak.Cli validators.py still has
 * the pre-fix class until the packs are re-vendored there).
 */
function nino(match: string): boolean {
  const clean = match.replace(/\s/g, '').toUpperCase();
  if (/^[DFIQUV]/.test(clean)) return false;
  if (/^.[DFIOQUV]/.test(clean)) return false;
  if (/^(?:BG|GB|NK|KN|TN|NT|ZZ)/.test(clean)) return false;
  return true;
}

/** UK NHS number mod-11 check digit. */
function nhs(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 10) return false;
  const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i], 10) * weights[i];
  const checkDigit = 11 - (sum % 11);
  if (checkDigit === 11) return parseInt(digits[9], 10) === 0;
  if (checkDigit === 10) return false; // invalid
  return checkDigit === parseInt(digits[9], 10);
}

/**
 * UK driving licence driver number (T100, best-effort): after stripping
 * spaces the 16-char code carries a 6-digit encoded date of birth at
 * positions 6-11 (decade digit, month 01-12 or 51-62 for women, day
 * 01-31, year-in-decade digit). There is no public checksum for the
 * final check characters, so only the date block is validated.
 */
function ukDrivingLicence(match: string): boolean {
  const clean = match.replace(/\s/g, '').toUpperCase();
  if (clean.length !== 16) return false;
  const dob = clean.slice(5, 11);
  if (!/^\d{6}$/.test(dob)) return false;
  const rawMonth = parseInt(dob.slice(1, 3), 10);
  const month = rawMonth > 50 ? rawMonth - 50 : rawMonth;
  if (month < 1 || month > 12) return false;
  const day = parseInt(dob.slice(3, 5), 10);
  if (day < 1 || day > 31) return false;
  return true;
}

/** Polish PESEL weighted checksum. */
function pesel(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(digits[10], 10);
}

/** Polish ID card (3 letters + 6 digits) weighted checksum. */
function plIdCard(match: string): boolean {
  const clean = match.replace(/\s/g, '').toUpperCase();
  if (clean.length !== 9) return false;
  // First 3 chars are letters (A=10..Z=35), remaining 6 are digits
  // Weights: [7, 3, 1, 0, 7, 3, 1, 7, 3] where position 4 (index 3) is the check digit
  const weights = [7, 3, 1, 0, 7, 3, 1, 7, 3];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const ch = clean[i];
    const val = ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : parseInt(ch, 10);
    if (i === 3) continue; // skip check digit position
    sum += val * weights[i];
  }
  const checkDigit = sum % 10;
  return checkDigit === parseInt(clean[3], 10);
}

/** Polish NIP weighted mod-11 checksum. */
function nip(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 10) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  return (sum % 11) === parseInt(digits[9], 10);
}

/** Polish REGON checksum (9- or 14-digit variant). */
function regon(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length === 9) {
    const weights = [8, 9, 2, 3, 4, 5, 6, 7];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += parseInt(digits[i], 10) * weights[i];
    const checkDigit = sum % 11 === 10 ? 0 : sum % 11;
    return checkDigit === parseInt(digits[8], 10);
  }
  if (digits.length === 14) {
    const weights = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8];
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += parseInt(digits[i], 10) * weights[i];
    const checkDigit = sum % 11 === 10 ? 0 : sum % 11;
    return checkDigit === parseInt(digits[13], 10);
  }
  return false;
}

/** Swedish personnummer Luhn check (excludes samordningsnummer, day >= 61). */
function personnummer(match: string): boolean {
  const digits = match.replace(/[\s-]/g, '');
  if (digits.length < 10) return false;
  // Exclude samordningsnummer (day >= 61)
  const cleanForDay = match.replace(/[-+]/g, '');
  const day = parseInt(cleanForDay.substring(4, 6), 10);
  if (day >= 61) return false;
  // Use last 10 digits for Luhn check
  const last10 = digits.slice(-10);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = parseInt(last10[i], 10) * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(last10[9], 10);
}

/** Swedish samordningsnummer (coordination number): day portion is 61+. */
function samordningsnummer(match: string): boolean {
  const digits = match.replace(/[-+]/g, '');
  if (digits.length < 10) return false;
  // Day portion is positions 4-5 (in YYMMDD format)
  const day = parseInt(digits.substring(4, 6), 10);
  return day >= 61;
}

/**
 * US DEA number checksum.
 * (d1+d3+d5) + 2*(d2+d4+d6) mod 10 == d7
 * Plus: first letter must be a valid registrant type, second letter is the
 * first letter of the registrant's last name (so any A-Z is allowed there).
 */
function dea(match: string): boolean {
  const m = match.toUpperCase();
  if (!/^[ABCDEFGHJKLMPRSTUX][A-Z]\d{7}$/.test(m)) return false;
  const digits = m.slice(2).split('').map(Number);
  const sum = digits[0] + digits[2] + digits[4] + 2 * (digits[1] + digits[3] + digits[5]);
  return sum % 10 === digits[6];
}

/**
 * US NPI Luhn check with the CMS-mandated 80840 prefix.
 * The NPI is 10 digits; Luhn is computed over "80840" + first 9 digits,
 * and the 10th digit must equal the resulting Luhn check digit.
 */
function npi(match: string): boolean {
  const d = match.replace(/\D/g, '');
  if (d.length !== 10) return false;
  const payload = '80840' + d.slice(0, 9);
  let sum = 0;
  let alt = true; // rightmost digit (excluding the check digit) is doubled
  for (let i = payload.length - 1; i >= 0; i--) {
    let n = parseInt(payload[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(d[9], 10);
}

/**
 * US ABA routing number checksum.
 * (3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9)) mod 10 == 0
 */
function aba(match: string): boolean {
  const d = match.replace(/\D/g, '');
  if (d.length !== 9) return false;
  const n = d.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

/** French NIR / INSEE number: gender digit + mod-97 key over the first 13 digits. */
function nir(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 15) return false;
  const gender = digits[0];
  if (gender !== '1' && gender !== '2') return false;
  // First 13 digits, last 2 are check
  const first13 = parseInt(digits.substring(0, 13), 10);
  const key = parseInt(digits.substring(13, 15), 10);
  return (97 - (first13 % 97)) === key;
}

/** Spanish DNI: number mod 23 selects the control letter. */
function dni(match: string): boolean {
  const clean = match.replace(/[\s-]/g, '').toUpperCase();
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const numPart = clean.slice(0, -1);
  const letter = clean.slice(-1);
  const num = parseInt(numPart, 10);
  if (isNaN(num)) return false;
  return letters[num % 23] === letter;
}

/** Italian Codice Fiscale odd/even character table checksum. */
function codiceFiscale(match: string): boolean {
  const code = match.toUpperCase();
  if (code.length !== 16) return false;

  const oddValues: Record<string, number> = {
    '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
    A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
    K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
    U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
  };
  const evenValues: Record<string, number> = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
    K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
    U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
  };

  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = code[i];
    // Positions are 1-based: odd positions use oddValues, even use evenValues
    sum += (i % 2 === 0) ? oddValues[ch] : evenValues[ch];
  }
  const expectedCheck = String.fromCharCode('A'.charCodeAt(0) + (sum % 26));
  return code[15] === expectedCheck;
}

/** Italian Partita IVA Luhn-style checksum over 11 digits. */
function partitaIva(match: string): boolean {
  const digits = match.toUpperCase().replace(/^IT/, '');
  if (digits.length !== 11 || !/^\d{11}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let n = parseInt(digits[i], 10);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Dutch BSN elfproef (11-test) with negative weight on the last digit. */
function bsn(match: string): boolean {
  if (match.length !== 9 || !/^\d{9}$/.test(match)) return false;

  const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(match[i], 10) * weights[i];
  }
  return sum > 0 && sum % 11 === 0;
}

/** Portuguese NIF: first-digit restriction + mod-11 check digit. */
function nif(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  // First digit must not be 0, 3, 4, or 7
  const first = parseInt(digits[0], 10);
  if (first === 0 || first === 3 || first === 4 || first === 7) return false;
  const weights = [9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += parseInt(digits[i], 10) * weights[i];
  const remainder = sum % 11;
  const checkDigit = remainder < 2 ? 0 : 11 - remainder;
  return checkDigit === parseInt(digits[8], 10);
}

/** Norwegian fodselsnummer: two mod-11 control digits, day 01-31 (excludes D-nummer). */
function fodselsnummer(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  const day = parseInt(digits.substring(0, 2), 10);
  // Fødselsnummer has day 01-31; D-nummer has day 41-71
  if (day >= 41) return false;
  const d = digits.split('').map(Number);
  // Control digit 1
  const k1 = 11 - ((3*d[0] + 7*d[1] + 6*d[2] + 1*d[3] + 8*d[4] + 9*d[5] + 4*d[6] + 5*d[7] + 2*d[8]) % 11);
  const c1 = k1 === 11 ? 0 : k1;
  if (c1 === 10 || c1 !== d[9]) return false;
  // Control digit 2
  const k2 = 11 - ((5*d[0] + 4*d[1] + 3*d[2] + 2*d[3] + 7*d[4] + 6*d[5] + 5*d[6] + 4*d[7] + 3*d[8] + 2*d[9]) % 11);
  const c2 = k2 === 11 ? 0 : k2;
  if (c2 === 10 || c2 !== d[10]) return false;
  return true;
}

/** Norwegian D-nummer: day portion shifted by +40 (41-71). */
function dNummer(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  const day = parseInt(digits.substring(0, 2), 10);
  // D-nummer: first digit has 4 added, so day is 41-71
  if (day < 41 || day > 71) return false;
  return true;
}

/** Belgian National Register Number mod-97 check (pre- and post-2000 variants). */
function belgianNrn(match: string): boolean {
  const digits = match.replace(/[\s.-]/g, '');
  if (digits.length !== 11 || !/^\d{11}$/.test(digits)) return false;

  const first9 = parseInt(digits.substring(0, 9), 10);
  const check = parseInt(digits.substring(9, 11), 10);

  // Born before 2000
  if ((97 - (first9 % 97)) === check) return true;

  // Born 2000+: prepend '2' to the first 9 digits
  const first9with2 = parseInt('2' + digits.substring(0, 9), 10);
  if ((97 - (first9with2 % 97)) === check) return true;

  return false;
}

/** Austrian SVNR weighted mod-11 checksum (check digit at position 4). */
function svnr(match: string): boolean {
  const digits = match.replace(/\s/g, '');
  if (digits.length !== 10 || !/^\d{10}$/.test(digits)) return false;

  const serial = parseInt(digits.substring(0, 3), 10);
  if (serial < 100) return false;

  const weights = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 3) continue; // skip check digit position for sum
    sum += parseInt(digits[i], 10) * weights[i];
  }
  const check = sum % 11;
  if (check === 10) return false;
  return check === parseInt(digits[3], 10);
}

/** Swiss AHV/AVS number EAN-13 checksum (756 prefix). */
function ahv(match: string): boolean {
  const digits = match.replace(/[\s.]/g, '');
  if (digits.length !== 13 || !digits.startsWith('756')) return false;
  const weights = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(digits[12], 10);
}

/** German Steuer-ID check digit (ISO 7064 Mod 11,10). */
function steuerId(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (digits[0] === '0') return false;
  // Check digit validation (ISO 7064 Mod 11,10)
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (parseInt(digits[i], 10) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const checkDigit = (11 - product) % 10;
  return checkDigit === parseInt(digits[10], 10);
}

/** Finnish HETU: mod-31 check character over date + individual number. */
function hetu(match: string): boolean {
  const upper = match.toUpperCase();
  const ddmmyy = upper.slice(0, 6);
  const nnn = upper.slice(7, 10);
  const checkChar = upper[10];
  const number = parseInt(ddmmyy + nnn, 10);
  const checkChars = '0123456789ABCDEFHJKLMNPRSTUVWXY';
  const remainder = number % 31;
  return checkChars[remainder] === checkChar;
}

/** Irish PPS number: weighted mod-23 check character (with optional W suffix). */
function pps(match: string): boolean {
  const upper = match.toUpperCase();
  const digits = upper.slice(0, 7);
  const checkChar = upper[7];
  const suffix = upper.length > 8 ? upper[8] : undefined;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  if (suffix && suffix !== 'W') {
    sum += (suffix.charCodeAt(0) - 64) * 9;
  }
  const remainder = sum % 23;
  const expected = remainder === 0 ? 'W' : String.fromCharCode(64 + remainder);
  return checkChar === expected;
}

/**
 * Shannon entropy of a string in bits per character. Exported for tests
 * and threshold tuning; the secrets-tier validators below gate the
 * generic candidate rules on it (detect-secrets / Prompt Armour
 * precedent). Named patterns (AKIA..., ghp_...) need no entropy gate.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Generic "keyword = value" secret assignment. The rule includes the
 * keyword and separator in the match (lookbehind is banned for new
 * rules), so extract the value: everything after the first ':' or '=',
 * with quotes/whitespace and base64 '=' padding stripped. Gate it on
 * Shannon entropy: pure-hex values pass at >= 3.0 bits/char (random hex
 * tops out at 4.0), anything else needs >= 4.0. Pure-digit values are
 * rejected outright (IDs and phone numbers, not credentials).
 * Thresholds tuned in tests/regex/secrets.test.ts.
 */
function secretAssignment(match: string): boolean {
  const sep = match.search(/[:=]/);
  if (sep === -1) return false;
  const value = match.slice(sep + 1).replace(/^[>\s"']+/, '').replace(/=+$/, '');
  if (value.length < 16) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return shannonEntropy(value) >= 3.0;
  return shannonEntropy(value) >= 4.0;
}

/**
 * Bare high-entropy token gate for the generic base64/alphanumeric
 * candidate rule. Requires the shape of machine-generated key material:
 * 40-256 chars after stripping '=' padding (longer runs are data blobs
 * like base64 images, not credentials), a mix of lowercase, uppercase,
 * and digits (rejects git SHAs and UUIDs, which are single-case hex),
 * and Shannon entropy >= 4.5 bits/char (rejects identifiers and prose;
 * random 40+ char base64 sits near 4.8). Thresholds tuned in
 * tests/regex/secrets.test.ts.
 */
function highEntropyToken(match: string): boolean {
  const value = match.replace(/=+$/, '');
  if (value.length < 40 || value.length > 256) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) return false;
  return shannonEntropy(value) >= 4.5;
}

/**
 * The registry. Keys are the names allowed in the `validate` field of
 * rules/*.json; loader.ts throws at module init on any unknown name.
 */
export const VALIDATORS: Readonly<Record<string, RuleValidator>> = {
  aba,
  ahv,
  belgianNrn,
  bsn,
  codiceFiscale,
  dNummer,
  dea,
  dni,
  fodselsnummer,
  hetu,
  highEntropyToken,
  ibanMod97,
  ipOctets,
  luhn,
  nhs,
  nif,
  nino,
  nip,
  nir,
  npi,
  partitaIva,
  personnummer,
  pesel,
  plIdCard,
  pps,
  regon,
  samordningsnummer,
  secretAssignment,
  steuerId,
  svnr,
  ukDrivingLicence,
};
