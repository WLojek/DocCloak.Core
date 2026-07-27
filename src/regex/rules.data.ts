// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
// Generated from rules/*.json by scripts/generate-rules-module.mjs.
// The JSON files are the canonical rule source (arch doc section 6);
// after editing any of them run: npm run rules:gen
import type { RegionRulesJson } from './loader.ts';

export const RULES_DATA: readonly RegionRulesJson[] = [
  {
    "region": "universal",
    "rules": [
      {
        "id": "regex:universal:email",
        "entityType": "EMAIL",
        "pattern": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
        "flags": "g",
        "confidence": 0.95,
        "domains": [
          "contact"
        ],
        "description": "Email address",
        "examples": [
          "john@example.com",
          "user.name+tag@domain.co.uk"
        ]
      },
      {
        "id": "regex:universal:phone_intl",
        "entityType": "PHONE",
        "pattern": "\\+\\d[\\d\\s()-]{7,18}\\d",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "International phone number with + prefix",
        "examples": [
          "+1 (555) 123-4567",
          "+48 600 123 456",
          "+44 20 7946 0958"
        ]
      },
      {
        "id": "regex:universal:iban",
        "entityType": "IBAN",
        "pattern": "\\b[A-Z]{2}\\s?\\d{2}[\\s]?[A-Z\\d\\s]{10,30}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "IBAN (2-letter country code + 2 check digits + up to 30 alphanumeric)",
        "examples": [
          "GB29 NWBK 6016 1331 9268 19",
          "DE89 3704 0044 0532 0130 00",
          "PL61 1090 1014 0000 0712 1981 2874"
        ],
        "validate": "ibanMod97"
      },
      {
        "id": "regex:universal:credit_card",
        "entityType": "CREDIT_CARD",
        "pattern": "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{1,7}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Credit/debit card number (13-19 digits, possibly spaced/dashed)",
        "examples": [
          "4532 0151 1283 0366",
          "5425-2334-3010-9903"
        ],
        "falsePositiveNotes": "Luhn validation reduces false positives from random digit sequences",
        "validate": "luhn"
      },
      {
        "id": "regex:universal:currency_symbol_prefix",
        "entityType": "CURRENCY",
        "pattern": "[$€£¥₹₽₩₺₴]\\s?\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "financial"
        ],
        "description": "Currency amount with leading symbol ($, €, £, ¥, ₹, ₽, ₩, ₺, ₴)",
        "examples": [
          "$45,000",
          "€1.234,56",
          "£100.00",
          "¥50,000"
        ]
      },
      {
        "id": "regex:universal:currency_code_suffix",
        "entityType": "CURRENCY",
        "pattern": "\\b\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?\\s?(?:USD|EUR|GBP|CHF|JPY|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN|HRK|RUB|UAH|TRY|BRL|ARS|MXN|COP|CLP|PEN|INR|CNY|KRW|AUD|CAD|NZD|ZAR|SGD|HKD|TWD|THB|MYR|IDR|PHP|VND|AED|SAR|QAR|KWD|BHD|OMR|ILS|EGP|NGN|KES|GHS|TZS|UGX)\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "financial"
        ],
        "description": "Currency amount with trailing ISO code (e.g., \"1,000.00 USD\")",
        "examples": [
          "1,000.00 USD",
          "45 000 PLN",
          "100.50 EUR"
        ]
      },
      {
        "id": "regex:universal:currency_symbol_suffix",
        "entityType": "CURRENCY",
        "pattern": "\\b\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?\\s?(?:zł|kr|Kč|lei|лв|Ft|kn|₽|грн|₺|R\\$|S\\/\\.|руб|₹|元|圆|円|원|ر\\.س|ر\\.ق|د\\.إ|₪|₦|₵|₱|₫|₸|₼|₾|฿|RM|Rp|đ)(?=\\s|$|[.,;:!?)}\\]])",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "financial"
        ],
        "description": "Currency amount with trailing local symbol (zł, kr, Kč, lei, etc.)",
        "examples": [
          "8 500,00 zł",
          "1 200 kr",
          "3.500 Kč",
          "10 000 lei",
          "5 000 Ft"
        ]
      },
      {
        "id": "regex:universal:ipv4",
        "entityType": "IP_ADDRESS",
        "pattern": "\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "technical"
        ],
        "description": "IPv4 address",
        "examples": [
          "192.168.1.1",
          "10.0.0.255",
          "172.16.0.1"
        ],
        "validate": "ipOctets"
      },
      {
        "id": "regex:universal:ipv6",
        "entityType": "IP_ADDRESS",
        "pattern": "\\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "technical"
        ],
        "description": "IPv6 address (full form)",
        "examples": [
          "2001:0db8:85a3:0000:0000:8a2e:0370:7334"
        ]
      },
      {
        "id": "regex:universal:mac_address",
        "entityType": "OTHER",
        "pattern": "\\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "technical"
        ],
        "description": "MAC address (colon-separated)",
        "examples": [
          "00:1B:44:11:3A:B7"
        ]
      },
      {
        "id": "regex:universal:date_numeric",
        "entityType": "DATE",
        "pattern": "\\b\\d{1,2}[./]\\d{1,2}[./]\\d{4}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "general"
        ],
        "description": "Numeric date (dd.mm.yyyy, dd/mm/yyyy, mm/dd/yyyy)",
        "examples": [
          "15.03.2025",
          "03/15/2025",
          "1.1.2024"
        ],
        "falsePositiveNotes": "Cannot distinguish dd/mm/yyyy from mm/dd/yyyy — both valid"
      },
      {
        "id": "regex:universal:date_iso",
        "entityType": "DATE",
        "pattern": "\\b\\d{4}-\\d{2}-\\d{2}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "general"
        ],
        "description": "ISO 8601 date (yyyy-mm-dd)",
        "examples": [
          "2025-03-15",
          "1990-01-01"
        ]
      },
      {
        "id": "regex:universal:date_word",
        "entityType": "DATE",
        "pattern": "\\b\\d{1,2}\\s+[\\p{L}]{3,}\\s+\\d{4}\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "general"
        ],
        "description": "Date with month name in any language (e.g., \"10 marca 2025\", \"15 March 2025\")",
        "examples": [
          "10 March 2025",
          "15 marca 2025",
          "1 janvier 2024"
        ]
      },
      {
        "id": "regex:universal:date_month_first",
        "entityType": "DATE",
        "pattern": "\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+\\d{4}\\b",
        "flags": "gi",
        "confidence": 0.85,
        "domains": [
          "general"
        ],
        "description": "English date with month name first (e.g., \"March 15, 2025\")",
        "examples": [
          "March 15, 2025",
          "Jan 1 2024",
          "December 25, 2023"
        ]
      },
      {
        "id": "regex:universal:labeled_id",
        "entityType": "SSN",
        "pattern": "(?<=[\\p{L}][\\p{L}\\s]{0,30}[:#]\\s?)[A-Z0-9]{2,4}[\\s-]?[\\d]{4,}(?:[\\s-][\\d]+)*",
        "flags": "giu",
        "confidence": 0.7,
        "domains": [
          "identity",
          "general"
        ],
        "description": "Labeled identifier (Key: Value pattern, e.g., \"ID: ABC12345\", \"Ref: 987654\")",
        "examples": [
          "ID: ABC12345"
        ],
        "falsePositiveNotes": "Broad pattern — catches many key:value pairs that may not be PII"
      },
      {
        "id": "regex:universal:long_number",
        "entityType": "SSN",
        "pattern": "(?<![.\\d])\\b\\d[\\d\\s-]{7,}\\d\\b(?![.\\d])",
        "flags": "g",
        "confidence": 0.5,
        "domains": [
          "identity",
          "financial"
        ],
        "description": "Standalone long digit sequence (8+ digits) — likely IDs, account numbers, case numbers",
        "examples": [
          "123456789",
          "123-456-789-00"
        ],
        "falsePositiveNotes": "Low confidence — many non-PII numbers match. Overlap resolution with specific patterns prevents double-detection."
      },
      {
        "id": "regex:universal:postal_city",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{2,5}[-\\s]?\\d{2,4}\\s+[\\p{L}][\\p{L}]+\\b",
        "flags": "gu",
        "confidence": 0.65,
        "domains": [
          "contact"
        ],
        "description": "Postal/zip code followed by city name (various country formats)",
        "examples": [
          "00-950 Warszawa",
          "75008 Paris"
        ],
        "falsePositiveNotes": "May match non-address number+word sequences"
      }
    ]
  },
  {
    "region": "gb",
    "rules": [
      {
        "id": "regex:gb:nino",
        "entityType": "SSN",
        "pattern": "\\b[A-Z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[A-D]\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr",
          "financial"
        ],
        "description": "UK National Insurance Number (NINO, e.g., AB 12 34 56 C)",
        "examples": [
          "AB 12 34 56 C",
          "CE123456C"
        ],
        "validate": "nino"
      },
      {
        "id": "regex:gb:nhs",
        "entityType": "SSN",
        "pattern": "\\b\\d{3}\\s?\\d{3}\\s?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.6,
        "domains": [
          "medical",
          "identity"
        ],
        "description": "UK NHS number (10 digits)",
        "examples": [
          "943 476 5919"
        ],
        "falsePositiveNotes": "10-digit format overlaps with many phone numbers",
        "validate": "nhs"
      },
      {
        "id": "regex:gb:passport",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}\\b",
        "flags": "g",
        "confidence": 0.4,
        "domains": [
          "identity"
        ],
        "description": "UK passport number (9 digits)",
        "examples": [
          "123456789"
        ],
        "falsePositiveNotes": "Very broad — 9 digits matches many things. Best paired with context clues."
      },
      {
        "id": "regex:gb:sort_code",
        "entityType": "OTHER",
        "pattern": "\\b\\d{2}-\\d{2}-\\d{2}\\b",
        "flags": "g",
        "confidence": 0.65,
        "domains": [
          "financial"
        ],
        "description": "UK bank sort code (XX-XX-XX)",
        "examples": [
          "12-34-56"
        ],
        "falsePositiveNotes": "Also matches dates in dd-mm-yy format"
      },
      {
        "id": "regex:gb:bank_account",
        "entityType": "OTHER",
        "pattern": "\\b\\d{7,8}\\b",
        "flags": "g",
        "confidence": 0.3,
        "domains": [
          "financial"
        ],
        "description": "UK bank account number (7-8 digits)",
        "examples": [
          "12345678"
        ],
        "falsePositiveNotes": "Extremely broad — disabled by default in low-sensitivity mode"
      },
      {
        "id": "regex:gb:vat",
        "entityType": "SSN",
        "pattern": "\\b(?:GB)?\\d{3}\\s?\\d{4}\\s?\\d{2}(?:\\s?\\d{3})?\\b",
        "flags": "gi",
        "confidence": 0.75,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "UK VAT number (GB + 9 or 12 digits)",
        "examples": [
          "GB123 4567 89",
          "GB123456789"
        ]
      },
      {
        "id": "regex:gb:phone_landline",
        "entityType": "PHONE",
        "pattern": "\\b0\\d{4}\\s?\\d{6}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "UK landline phone number (e.g., 020 7946 0958)",
        "examples": [
          "01234 567890",
          "02079 460958"
        ]
      },
      {
        "id": "regex:gb:phone_mobile",
        "entityType": "PHONE",
        "pattern": "\\b07\\d{3}\\s?\\d{6}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "UK mobile phone number (07XXX XXXXXX)",
        "examples": [
          "07911 123456"
        ]
      },
      {
        "id": "regex:gb:postcode",
        "entityType": "ADDRESS",
        "pattern": "\\b[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}\\b",
        "flags": "gi",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "UK postcode (e.g., SW1A 1AA, EC2A 1NT, M1 1AA)",
        "examples": [
          "SW1A 1AA",
          "EC2A 1NT",
          "M1 1AA",
          "B33 8TH"
        ]
      },
      {
        "id": "regex:gb:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:in\\s+(?:the\\s+)?(?:amount|sum)\\s+of|pay(?:able)?(?:\\s+the\\s+(?:amount|sum))?\\s+of)\\s+[\\p{L}\\s-]+(?:pounds?|pence|sterling)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "English (UK) amount written in words (e.g., \"in the amount of eight thousand five hundred pounds\")",
        "examples": [
          "in the amount of eight thousand five hundred pounds"
        ]
      },
      {
        "id": "regex:gb:street",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{1,4}[A-Z]?\\s+[A-Z][\\w]+(?:\\s+[A-Z][\\w]+)*\\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl|Crescent|Cres|Terrace|Terr|Place|Pl|Gardens|Gdns|Grove|Way|Court|Ct|Square|Sq|Mews|Row|Rise|Hill|Park|Gate|Walk|Green|Parade|Wharf)\\.?\\b",
        "flags": "gi",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "UK street address (number + street name + type)",
        "examples": [
          "10 Downing Street",
          "221B Baker Street",
          "42 Oxford Road"
        ]
      },
      {
        "id": "regex:gb:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:,?\\s+)?(?:Ltd\\.?|PLC|LLP|L\\.L\\.P\\.)\\b",
        "flags": "gu",
        "confidence": 0.85,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "UK company name with legal suffix (Ltd, PLC, LLP)",
        "examples": [
          "Barclays PLC",
          "Tesco Ltd",
          "Deloitte LLP"
        ]
      }
    ]
  },
  {
    "region": "pl",
    "rules": [
      {
        "id": "regex:pl:pesel",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}[0-3]\\d[0-3]\\d{6}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Polish PESEL national identification number (11 digits, YYMMDD + 5)",
        "examples": [
          "89052310002",
          "02271400004"
        ],
        "validate": "pesel"
      },
      {
        "id": "regex:pl:id_card",
        "entityType": "SSN",
        "pattern": "\\b[A-Z]{3}\\s?\\d{6}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "identity"
        ],
        "description": "Polish ID card number (3 letters + 6 digits)",
        "examples": [
          "ABC 523456"
        ],
        "validate": "plIdCard"
      },
      {
        "id": "regex:pl:passport",
        "entityType": "SSN",
        "pattern": "\\b[A-Z]{2}\\s?\\d{7}\\b",
        "flags": "g",
        "confidence": 0.7,
        "domains": [
          "identity"
        ],
        "description": "Polish passport number (2 letters + 7 digits)",
        "examples": [
          "AB 1234567",
          "CD1234567"
        ]
      },
      {
        "id": "regex:pl:nip",
        "entityType": "SSN",
        "pattern": "\\b\\d{3}-?\\d{3}-?\\d{2}-?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Polish NIP tax identification number (10 digits, XXX-XXX-XX-XX)",
        "examples": [
          "123-456-78-19",
          "1234567819"
        ],
        "validate": "nip"
      },
      {
        "id": "regex:pl:regon",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}(?:\\d{5})?\\b",
        "flags": "g",
        "confidence": 0.6,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Polish REGON business registry number (9 or 14 digits)",
        "examples": [
          "123456785"
        ],
        "falsePositiveNotes": "9-digit REGON overlaps with many other number formats",
        "validate": "regon"
      },
      {
        "id": "regex:pl:bank_account",
        "entityType": "OTHER",
        "pattern": "\\b\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "financial"
        ],
        "description": "Polish bank account number (26 digits, often spaced in groups of 4)",
        "examples": [
          "1234 5678 9012 3456 7890 1234 56"
        ]
      },
      {
        "id": "regex:pl:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?48[\\s-]?)?\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Polish phone number (9 digits, optionally with +48 prefix)",
        "examples": [
          "+48 600 123 456",
          "600-123-456",
          "48 600123456"
        ]
      },
      {
        "id": "regex:pl:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{2}-\\d{3}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Polish postal code (XX-XXX) followed by city name",
        "examples": [
          "00-950 Warszawa",
          "31-501 Kraków",
          "80-244 Gdańsk Wrzeszcz"
        ]
      },
      {
        "id": "regex:pl:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:słownie:\\s*)[\\p{L}\\s]+(?:złot(?:ych|y|e)|groszy|grosz(?:e)?)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Polish amount written in words after \"słownie:\" (e.g., \"słownie: osiem tysięcy pięćset złotych\")",
        "examples": [
          "słownie: osiem tysięcy pięćset złotych"
        ]
      },
      {
        "id": "regex:pl:street",
        "entityType": "ADDRESS",
        "pattern": "(?:ul\\.|al\\.|pl\\.|os\\.)\\s+[\\p{L}][\\p{L}\\s]+\\s+\\d+[\\p{L}]?(?:\\s*[/\\\\]\\s*\\d+[\\p{L}]?)?",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "Polish street address (ul./al./pl./os. + name + number)",
        "examples": [
          "ul. Floriańska 27/3",
          "ul. Juliusza Słowackiego 15/8",
          "al. Krakowska 42",
          "os. Złotego Wieku 12"
        ]
      },
      {
        "id": "regex:pl:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s]+(?:Sp(?:ółka)?\\s*z\\s*o\\.?\\s*o\\.?|Spółka\\s+z\\s+ograniczon[\\p{L}]+\\s+odpowiedzialno[\\p{L}]+|Sp\\.\\s*j\\.|S\\.A\\.|Sp\\.\\s*k\\.)",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Polish company name with legal form (Sp. z o.o., S.A., Sp. j., Sp. k.)",
        "examples": [
          "Santander Bank Polska S.A.",
          "NOVAMED Spółka z ograniczoną odpowiedzialnością"
        ]
      },
      {
        "id": "regex:pl:court_case",
        "entityType": "OTHER",
        "pattern": "\\b[IVXLCDM]+\\s+(?:K|C|Ca|Cz|Co|Gz|Ga|GCo|GC)\\s+\\d+\\/\\d{2,4}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "legal"
        ],
        "description": "Polish court case signature (e.g., \"III K 123/24\", \"I C 456/2023\")",
        "examples": [
          "III K 123/24",
          "I C 456/2023"
        ]
      },
      {
        "id": "regex:pl:krs",
        "entityType": "OTHER",
        "pattern": "\\b\\d{4}\\/\\d{8}\\/\\d{4}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Polish KRS company registry number",
        "examples": [
          "0000/12345678/0001"
        ]
      }
    ]
  },
  {
    "region": "de",
    "rules": [
      {
        "id": "regex:de:personalausweis",
        "entityType": "SSN",
        "pattern": "\\b[CFGHJKLMNPRTVWXYZ]\\d{2}[CFGHJKLMNPRTVWXYZ0-9]{6}\\d\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "identity"
        ],
        "description": "German ID card number (Personalausweisnummer)",
        "examples": [
          "T220001297"
        ]
      },
      {
        "id": "regex:de:passport",
        "entityType": "SSN",
        "pattern": "\\b[CFGHJKLMNPRTVWXYZ]\\d{2}[CFGHJKLMNPRTVWXYZ0-9]{5}\\d[A-Z]\\d{7}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "identity"
        ],
        "description": "German passport number",
        "examples": [
          "C01X00T47D1234567"
        ]
      },
      {
        "id": "regex:de:steuernummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{2,3}\\/?\\d{3}\\/?\\d{4,5}\\b",
        "flags": "g",
        "confidence": 0.6,
        "domains": [
          "financial"
        ],
        "description": "German tax number (Steuernummer, 10-11 digits, format varies by state)",
        "examples": [
          "93/815/08152",
          "2181508152"
        ],
        "falsePositiveNotes": "Format varies by Bundesland — hard to validate precisely"
      },
      {
        "id": "regex:de:steuerid",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}\\s?\\d{3}\\s?\\d{3}\\s?\\d{3}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "financial",
          "identity"
        ],
        "description": "German tax ID (Steuerliche Identifikationsnummer, 11 digits)",
        "examples": [
          "12 345 678 903"
        ],
        "validate": "steuerId"
      },
      {
        "id": "regex:de:vat",
        "entityType": "SSN",
        "pattern": "\\b(?:DE)?\\d{9}\\b",
        "flags": "gi",
        "confidence": 0.65,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "German VAT number (USt-IdNr., DE + 9 digits)",
        "examples": [
          "DE123456789"
        ],
        "falsePositiveNotes": "Without DE prefix, 9 digits alone has many false positives"
      },
      {
        "id": "regex:de:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?49[\\s-]?)?\\(?\\d{2,5}\\)?[\\s-]?\\d{3,10}\\b",
        "flags": "g",
        "confidence": 0.7,
        "domains": [
          "contact"
        ],
        "description": "German phone number (variable-length area codes)",
        "examples": [
          "+49 30 12345678",
          "089/12345678",
          "(030) 12345678"
        ],
        "falsePositiveNotes": "Variable-length area codes make this pattern broad"
      },
      {
        "id": "regex:de:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "German postal code (5 digits) followed by city name",
        "examples": [
          "10115 Berlin",
          "80331 München"
        ]
      },
      {
        "id": "regex:de:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:in\\s+(?:Höhe|Worten?)\\s+(?:von\\s+)?|(?:Betrag|Summe)\\s+von\\s+)[\\p{L}\\s-]+(?:Euro|Cent)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "German amount written in words (e.g., \"in Höhe von achttausendfünfhundert Euro\")",
        "examples": [
          "in Höhe von achttausendfünfhundert Euro"
        ]
      },
      {
        "id": "regex:de:street",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s-]*(?:straße|strasse|str\\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee)\\s+\\d+[\\p{L}]?(?:\\s*[/\\\\]\\s*\\d+)?",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "German street address (name + straße/str./weg/gasse/platz + number)",
        "examples": [
          "Friedrichstraße 43",
          "Berliner Str. 12",
          "Hauptplatz 1",
          "Am Damm 7a"
        ]
      },
      {
        "id": "regex:de:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.]+(?:\\s+)?(?:GmbH|AG|KG|OHG|e\\.?\\s?V\\.?|GbR|UG|mbH|KGaA)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "German company name with legal form (GmbH, AG, KG, OHG, e.V., GbR, UG)",
        "examples": [
          "Deutsche Bank AG",
          "Siemens GmbH",
          "Bosch KG"
        ]
      },
      {
        "id": "regex:de:icd10gm",
        "entityType": "OTHER",
        "pattern": "\\b[A-Z]\\d{2}(?:\\.\\d{1,2})?(?:\\s?[GLRAZ])?\\b",
        "flags": "g",
        "confidence": 0.55,
        "domains": [
          "medical"
        ],
        "description": "ICD-10-GM diagnosis code (German modification)",
        "examples": [
          "J18.9 G",
          "E11.65"
        ],
        "falsePositiveNotes": "Very short codes — high false positive risk"
      },
      {
        "id": "regex:de:sozialversicherung",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}(?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{2}[A-Z]\\d{2}\\d\\b",
        "flags": "gi",
        "confidence": 0.75,
        "domains": [
          "hr",
          "identity"
        ],
        "description": "German social insurance number (Sozialversicherungsnummer, 12 chars: area + DDMMYY birth date + letter + serial + check digit)",
        "examples": [
          "12010182A056"
        ]
      }
    ]
  },
  {
    "region": "fr",
    "rules": [
      {
        "id": "regex:fr:nir",
        "entityType": "SSN",
        "pattern": "\\b[12]\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{3}\\s?\\d{3}(?:\\s?\\d{2})?\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "identity",
          "medical",
          "hr"
        ],
        "description": "French NIR / INSEE number (numéro de sécurité sociale, 13+2 digits)",
        "examples": [
          "1 85 05 78 049 013 36"
        ],
        "validate": "nir"
      },
      {
        "id": "regex:fr:passport",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}[A-Z]{2}\\d{5}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "identity"
        ],
        "description": "French passport number (2 digits + 2 letters + 5 digits)",
        "examples": [
          "12AB34567"
        ]
      },
      {
        "id": "regex:fr:cni",
        "entityType": "SSN",
        "pattern": "\\b\\d{12}\\b",
        "flags": "g",
        "confidence": 0.4,
        "domains": [
          "identity"
        ],
        "description": "French national ID card number (12 digits, new format)",
        "examples": [
          "123456789012"
        ],
        "falsePositiveNotes": "Very broad — 12 digits matches many things"
      },
      {
        "id": "regex:fr:siret",
        "entityType": "SSN",
        "pattern": "\\b\\d{3}\\s?\\d{3}\\s?\\d{3}(?:\\s?\\d{5})?\\b",
        "flags": "g",
        "confidence": 0.65,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "French SIRET (14 digits) or SIREN (9 digits) business number",
        "examples": [
          "362 521 879 00034",
          "362 521 879"
        ],
        "falsePositiveNotes": "9-digit SIREN overlaps with many formats"
      },
      {
        "id": "regex:fr:vat",
        "entityType": "SSN",
        "pattern": "\\b(?:FR)?\\d{2}\\s?\\d{9}\\b",
        "flags": "gi",
        "confidence": 0.75,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "French VAT number (FR + 2 digits + 9 digits SIREN)",
        "examples": [
          "FR12 362521879",
          "FR 12362521879"
        ]
      },
      {
        "id": "regex:fr:phone",
        "entityType": "PHONE",
        "pattern": "\\b0[1-9](?:\\s?\\d{2}){4}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "French phone number (0X XX XX XX XX)",
        "examples": [
          "01 23 45 67 89",
          "06 12 34 56 78",
          "0612345678"
        ]
      },
      {
        "id": "regex:fr:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}\\s+[\\p{L}][\\p{L}\\s'-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "French postal code (5 digits) followed by city name",
        "examples": [
          "75008 Paris",
          "69001 Lyon",
          "13001 Marseille"
        ]
      },
      {
        "id": "regex:fr:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:(?:soit|montant)\\s+(?:en\\s+)?(?:lettres?|toutes?\\s+lettres?)\\s*:\\s*|(?:la\\s+)?somme\\s+de\\s+)[\\p{L}\\s'-]+(?:euros?|centimes?)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "French amount written in words (e.g., \"soit en lettres: huit mille cinq cents euros\")",
        "examples": [
          "soit en lettres: huit mille cinq cents euros"
        ]
      },
      {
        "id": "regex:fr:street",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{1,5}(?:\\s*(?:bis|ter))?\\s*,?\\s*(?:rue|avenue|av\\.|boulevard|bd\\.?|place|pl\\.|impasse|allée|passage|chemin|route|quai|cours|square|voie|sentier|résidence)\\s+[\\p{L}][\\p{L}\\s'-]+",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "French street address (number + rue/avenue/boulevard + name)",
        "examples": [
          "12 rue de Rivoli",
          "42 avenue des Champs-Élysées",
          "8 bis boulevard Haussmann"
        ]
      },
      {
        "id": "regex:fr:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:SARL|SAS|SA|EURL|SCI|SNC|SASU)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "French company name with legal form (SARL, SAS, SA, EURL, SCI, SNC)",
        "examples": [
          "Total SA",
          "Capgemini SAS",
          "Dupont et Fils SARL"
        ]
      },
      {
        "id": "regex:fr:carte_vitale",
        "entityType": "OTHER",
        "pattern": "\\b\\d{1}\\s?\\d{2}\\s?\\d{2}\\s?\\d{3}\\s?\\d{3}\\b",
        "flags": "g",
        "confidence": 0.7,
        "domains": [
          "medical"
        ],
        "description": "French Carte Vitale number (same as NIR, 13 digits)",
        "examples": [
          "1 85 05 780 490"
        ],
        "falsePositiveNotes": "Duplicate of NIR — overlap resolution will keep one"
      }
    ]
  },
  {
    "region": "es",
    "rules": [
      {
        "id": "regex:es:dni",
        "entityType": "SSN",
        "pattern": "\\b\\d{8}[\\s-]?[A-Z]\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity"
        ],
        "description": "Spanish DNI (8 digits + letter)",
        "examples": [
          "12345678Z",
          "12345678-Z"
        ],
        "validate": "dni"
      },
      {
        "id": "regex:es:nie",
        "entityType": "SSN",
        "pattern": "\\b[XYZ][\\s-]?\\d{7}[\\s-]?[A-Z]\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity"
        ],
        "description": "Spanish NIE for foreigners (X/Y/Z + 7 digits + letter)",
        "examples": [
          "X1234567L",
          "Y-1234567-A"
        ]
      },
      {
        "id": "regex:es:cif",
        "entityType": "SSN",
        "pattern": "\\b[A-H]\\d{7}[0-9A-J]\\b",
        "flags": "gi",
        "confidence": 0.8,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Spanish CIF company tax ID",
        "examples": [
          "A12345678",
          "B87654321"
        ]
      },
      {
        "id": "regex:es:cuenta_bancaria",
        "entityType": "SSN",
        "pattern": "\\b(?:ES)?\\d{2}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\b",
        "flags": "gi",
        "confidence": 0.8,
        "domains": [
          "financial"
        ],
        "description": "Spanish bank account number (CCC, 20 digits)",
        "examples": [
          "ES12 1234 5678 9012 3456 7890"
        ]
      },
      {
        "id": "regex:es:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?34[\\s-]?)?[6789]\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{3}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Spanish phone number (9 digits, optionally with +34)",
        "examples": [
          "+34 612 345 678",
          "912 345 678"
        ]
      },
      {
        "id": "regex:es:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}\\s+[\\p{L}][\\p{L}\\s'-]+\\b",
        "flags": "gu",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Spanish postal code (5 digits) followed by city name",
        "examples": [
          "28001 Madrid",
          "08001 Barcelona"
        ]
      },
      {
        "id": "regex:es:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:(?:en\\s+)?(?:letras?|palabras?)\\s*:\\s*|(?:la\\s+)?(?:cantidad|suma)\\s+de\\s+)[\\p{L}\\s-]+(?:euros?|céntimos?|pesos?|centavos?)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Spanish amount written in words (e.g., \"en letras: ocho mil quinientos euros\")",
        "examples": [
          "en letras: ocho mil quinientos euros"
        ]
      },
      {
        "id": "regex:es:street",
        "entityType": "ADDRESS",
        "pattern": "(?:(?:C(?:alle)?|Av(?:enida|da)?|Avda|Pza|Plaza|Pl|Paseo|P\\.º|Ronda|Ctra|Carretera|Camino|Travesía|Glorieta)\\.?\\s+)[\\p{L}][\\p{L}\\s'-]+(?:,?\\s*(?:n\\.?º?\\s*)?\\d+)?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Spanish street address (Calle/Avenida/Plaza + name + optional number)",
        "examples": [
          "Calle Mayor 15",
          "Av. de la Constitución 3",
          "Plaza de España"
        ]
      },
      {
        "id": "regex:es:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:S\\.L\\.U\\.|S\\.L\\.U|S\\.L\\.|S\\.L|S\\.A\\.U\\.|S\\.A\\.U|S\\.A\\.|S\\.A|S\\.C\\.)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Spanish company name with legal form (S.L., S.A., S.L.U., S.A.U., S.C.)",
        "examples": [
          "Telefónica S.A.",
          "Construcciones García S.L.",
          "Inditex S.A."
        ]
      },
      {
        "id": "regex:es:nuss",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}[-/]?\\d{8}[-/]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "medical",
          "hr"
        ],
        "description": "Spanish Social Security Number (NUSS/NAF, 12 digits: province + sequential + check)",
        "examples": [
          "28-12345678-56"
        ]
      }
    ]
  },
  {
    "region": "pt",
    "rules": [
      {
        "id": "regex:pt:cc",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}\\s?[A-Z]{2}\\d\\b",
        "flags": "gi",
        "confidence": 0.85,
        "domains": [
          "identity"
        ],
        "description": "Portuguese Cartão de Cidadão number (citizen card)",
        "examples": [
          "123456789 ZZ1"
        ]
      },
      {
        "id": "regex:pt:nif",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "financial",
          "identity"
        ],
        "description": "Portuguese NIF tax number (9 digits)",
        "examples": [
          "123456789"
        ],
        "falsePositiveNotes": "9 digits is very broad",
        "validate": "nif"
      },
      {
        "id": "regex:pt:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?351[\\s-]?)?\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Portuguese phone number (9 digits, optionally with +351)",
        "examples": [
          "+351 912 345 678",
          "912-345-678"
        ]
      },
      {
        "id": "regex:pt:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}-\\d{3}\\s+[\\p{L}][\\p{L}\\s'-]+\\b",
        "flags": "gu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Portuguese postal code (XXXX-XXX) followed by city name",
        "examples": [
          "1000-001 Lisboa",
          "4000-322 Porto"
        ]
      },
      {
        "id": "regex:pt:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:(?:por\\s+)?extenso\\s*:\\s*|(?:a\\s+)?(?:quantia|importância|soma)\\s+de\\s+)[\\p{L}\\s-]+(?:euros?|cêntimos?|reais|centavos?)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Portuguese amount written in words (e.g., \"por extenso: oito mil e quinhentos euros\")",
        "examples": [
          "por extenso: oito mil e quinhentos euros"
        ]
      },
      {
        "id": "regex:pt:street",
        "entityType": "ADDRESS",
        "pattern": "(?:(?:Rua|R\\.|Avenida|Av\\.|Praça|Pç\\.|Travessa|Tv\\.|Largo|Lg\\.|Alameda|Al\\.|Estrada|Est\\.)\\s+)[\\p{L}][\\p{L}\\s'-]+(?:,?\\s*(?:n\\.?º?\\s*)?\\d+)?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Portuguese street address (Rua/Avenida/Praça + name + optional number)",
        "examples": [
          "Rua Augusta 42",
          "Av. da Liberdade 10",
          "Praça do Comércio"
        ]
      },
      {
        "id": "regex:pt:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:Lda\\.?|S\\.A\\.?|SGPS)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Portuguese company name with legal form (Lda., S.A., SGPS)",
        "examples": [
          "Galp Energia S.A.",
          "Construções Silva Lda.",
          "EDP SGPS"
        ]
      }
    ]
  },
  {
    "region": "se",
    "rules": [
      {
        "id": "regex:se:personnummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{6}[-+]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Swedish personnummer (YYMMDD-XXXX or YYMMDDXXXX)",
        "examples": [
          "850523-0006",
          "8505230006"
        ],
        "validate": "personnummer"
      },
      {
        "id": "regex:se:personnummer_12",
        "entityType": "SSN",
        "pattern": "\\b(?:19|20)\\d{6}[-+]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Swedish personnummer 12-digit format (YYYYMMDD-XXXX)",
        "examples": [
          "19850523-1478",
          "198505231478"
        ]
      },
      {
        "id": "regex:se:samordningsnummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{6}[-+]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.7,
        "domains": [
          "identity"
        ],
        "description": "Swedish samordningsnummer (coordination number, day +60)",
        "examples": [
          "850583-1478"
        ],
        "falsePositiveNotes": "Same format as personnummer — differentiated by day > 60",
        "validate": "samordningsnummer"
      },
      {
        "id": "regex:se:organisationsnummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{6}-?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.6,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Swedish organisationsnummer (company number, 10 digits)",
        "examples": [
          "556036-0793"
        ],
        "falsePositiveNotes": "Same 10-digit format as personnummer"
      },
      {
        "id": "regex:se:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?46[\\s-]?)?0?\\d{1,3}[\\s-]?\\d{2,3}[\\s-]?\\d{2}[\\s-]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Swedish phone number (variable-length area code)",
        "examples": [
          "+46 8 123 45 67",
          "070-123 45 67"
        ]
      },
      {
        "id": "regex:se:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{3}\\s?\\d{2}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Swedish postal code (XXX XX) followed by city name",
        "examples": [
          "111 22 Stockholm",
          "41301 Göteborg"
        ]
      },
      {
        "id": "regex:se:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:(?:med\\s+)?(?:bokstäver|ord)\\s*:\\s*|(?:summan|beloppet)\\s+)[\\p{L}\\s-]+(?:kronor|öre)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Swedish amount written in words (e.g., \"med bokstäver: åttatusen femhundra kronor\")",
        "examples": [
          "med bokstäver: åttatusen femhundra kronor"
        ]
      },
      {
        "id": "regex:se:street",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s-]*(?:gatan|vägen|stigen|torget|platsen|gränd|backen|liden|ängen)\\s+\\d+[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "Swedish street address (name + gatan/vägen/etc. + number)",
        "examples": [
          "Drottninggatan 42",
          "Sveavägen 15",
          "Stortorget 3"
        ]
      },
      {
        "id": "regex:se:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:AB|HB|KB)\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Swedish company name with legal form (AB, HB, KB)",
        "examples": [
          "Volvo AB",
          "Handelsbanken AB",
          "Ericsson AB"
        ]
      }
    ]
  },
  {
    "region": "no",
    "rules": [
      {
        "id": "regex:no:fodselsnummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{6}\\s?\\d{5}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Norwegian fødselsnummer (birth number, 11 digits, DDMMYY + 5)",
        "examples": [
          "01019912368"
        ],
        "falsePositiveNotes": "11-digit sequences are common in other contexts",
        "validate": "fodselsnummer"
      },
      {
        "id": "regex:no:d_nummer",
        "entityType": "SSN",
        "pattern": "\\b\\d{6}\\s?\\d{5}\\b",
        "flags": "g",
        "confidence": 0.4,
        "domains": [
          "identity"
        ],
        "description": "Norwegian D-nummer (temporary ID for foreigners, 11 digits, day +40)",
        "examples": [
          "41019912345"
        ],
        "falsePositiveNotes": "Very broad match — 9 digits",
        "validate": "dNummer"
      },
      {
        "id": "regex:no:orgnr",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}\\s?(?:MVA)?\\b",
        "flags": "g",
        "confidence": 0.6,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Norwegian organization number (9 digits, optionally followed by MVA)",
        "examples": [
          "123456789",
          "123456789 MVA"
        ]
      },
      {
        "id": "regex:no:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?47[\\s-]?)?\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Norwegian phone number (8 digits, optionally with +47)",
        "examples": [
          "+47 12 34 56 78",
          "12345678"
        ]
      },
      {
        "id": "regex:no:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Norwegian postal code (4 digits) followed by city name",
        "examples": [
          "0001 Oslo",
          "5003 Bergen"
        ]
      },
      {
        "id": "regex:no:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:(?:med\\s+)?(?:bokstaver|ord)\\s*:\\s*|(?:summen|beløpet)\\s+)[\\p{L}\\s-]+(?:kroner|øre)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "Norwegian amount written in words (e.g., \"med bokstaver: åtte tusen fem hundre kroner\")",
        "examples": [
          "med bokstaver: åtte tusen fem hundre kroner"
        ]
      },
      {
        "id": "regex:no:street",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s-]*(?:gata|gaten|gate|veien|vegen|vei|veg|stien|torget|plassen|plass|allé|alleen)\\s+\\d+[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "Norwegian street address (name + gate/veien/vei/etc. + number)",
        "examples": [
          "Karl Johans gate 22",
          "Storgata 15",
          "Bygdøy allé 3"
        ]
      },
      {
        "id": "regex:no:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:AS|ASA|ANS|DA)\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Norwegian company name with legal form (AS, ASA, ANS, DA)",
        "examples": [
          "Equinor ASA",
          "Telenor ASA",
          "Nordea Bank ASA"
        ]
      }
    ]
  },
  {
    "region": "it",
    "rules": [
      {
        "id": "regex:it:codice_fiscale",
        "entityType": "SSN",
        "pattern": "\\b[A-Z]{6}\\d{2}[A-EHLMPRST]\\d{2}[A-Z]\\d{3}[A-Z]\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Italian fiscal code (Codice Fiscale, 16 alphanumeric characters)",
        "examples": [
          "RSSMRA85M01H501Q"
        ],
        "validate": "codiceFiscale"
      },
      {
        "id": "regex:it:partita_iva",
        "entityType": "SSN",
        "pattern": "\\bIT\\d{11}\\b",
        "flags": "gi",
        "confidence": 0.75,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "Italian VAT number (Partita IVA, IT + 11 digits)",
        "examples": [
          "IT12345678903"
        ],
        "validate": "partitaIva"
      },
      {
        "id": "regex:it:phone_mobile",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?39[\\s-]?)?3[0-9]{2}[\\s-]?\\d{3}[\\s-]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Italian mobile phone number (3xx prefix)",
        "examples": [
          "+39 345 123 4567",
          "3451234567"
        ]
      },
      {
        "id": "regex:it:phone_landline",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?39[\\s-]?)?0\\d{1,3}[\\s-]?\\d{4,8}\\b",
        "flags": "g",
        "confidence": 0.7,
        "domains": [
          "contact"
        ],
        "description": "Italian landline phone number (0x prefix)",
        "examples": [
          "+39 06 12345678",
          "02 12345678"
        ]
      },
      {
        "id": "regex:it:street",
        "entityType": "ADDRESS",
        "pattern": "(?:via|viale|v\\.le|piazza|p\\.zza|piazzale|corso|c\\.so|largo|vicolo|borgo|salita)\\s+[\\p{L}][\\p{L}\\s'.,-]+\\s*(?:,?\\s*n[°.]?\\s*)?\\d{1,5}[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "contact"
        ],
        "description": "Italian street address (Via/Piazza/Corso + name + number)",
        "examples": [
          "Via Roma, 42",
          "Piazza Navona 1",
          "Corso Vittorio Emanuele II, n. 23"
        ]
      },
      {
        "id": "regex:it:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Italian postal code (CAP, 5 digits) followed by city name",
        "examples": [
          "00100 Roma",
          "20121 Milano"
        ],
        "falsePositiveNotes": "5-digit postal codes overlap with US ZIP codes and other number formats"
      },
      {
        "id": "regex:it:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:S\\.?r\\.?l\\.?|S\\.?p\\.?A\\.?|S\\.?a\\.?s\\.?|S\\.?n\\.?c\\.?|S\\.?a\\.?p\\.?a\\.?)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Italian company name with legal form (S.r.l., S.p.A., S.a.s., S.n.c., S.a.p.a.)",
        "examples": [
          "Fiat Chrysler S.p.A.",
          "Ristorante Da Mario S.r.l."
        ]
      }
    ]
  },
  {
    "region": "nl",
    "rules": [
      {
        "id": "regex:nl:bsn",
        "entityType": "SSN",
        "pattern": "\\b\\d{9}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "identity",
          "hr"
        ],
        "description": "Dutch citizen service number (BSN, 9 digits with elfproef validation)",
        "examples": [
          "123456782"
        ],
        "falsePositiveNotes": "9 bare digits match many formats; elfproef validation essential",
        "validate": "bsn"
      },
      {
        "id": "regex:nl:phone_mobile",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?31[\\s-]?|0)6[\\s-]?\\d{4}[\\s-]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Dutch mobile phone number (06 prefix)",
        "examples": [
          "+31 6 1234 5678",
          "06 12345678"
        ]
      },
      {
        "id": "regex:nl:phone_landline",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?31[\\s-]?|0)[1-5]\\d[\\s-]?\\d{3}[\\s-]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Dutch landline phone number (area code prefix)",
        "examples": [
          "+31 20 123 4567",
          "020 1234567"
        ]
      },
      {
        "id": "regex:nl:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}\\s?[A-Z]{2}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Dutch postal code (4 digits + 2 letters)",
        "examples": [
          "1012 AB",
          "3511XA"
        ]
      },
      {
        "id": "regex:nl:street",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s'-]*(?:straat|weg|laan|plein|gracht|kade|singel|dijk|steeg|dreef|hof|markt)\\s+\\d{1,5}[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Dutch street address (name + straat/weg/laan/gracht + number)",
        "examples": [
          "Keizersgracht 123",
          "Dorpsstraat 45a",
          "Marktplein 7"
        ]
      },
      {
        "id": "regex:nl:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:\\s+)?(?:B\\.?V\\.?|N\\.?V\\.?|V\\.?O\\.?F\\.?|C\\.?V\\.?)\\b",
        "flags": "gu",
        "confidence": 0.9,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "Dutch company name with legal form (B.V., N.V., V.O.F., C.V.)",
        "examples": [
          "Philips N.V.",
          "Shell Nederland B.V."
        ]
      }
    ]
  },
  {
    "region": "be",
    "rules": [
      {
        "id": "regex:be:national_register",
        "entityType": "SSN",
        "pattern": "\\b\\d{2}[.\\s]?\\d{2}[.\\s]?\\d{2}[-.\\s]?\\d{3}[.\\s]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr"
        ],
        "description": "Belgian National Register Number (Rijksregisternummer / Numéro de registre national)",
        "examples": [
          "85.07.15-123.97",
          "85071512397"
        ],
        "validate": "belgianNrn"
      },
      {
        "id": "regex:be:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?32[\\s-]?|0)(?:4\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}|[1-9]\\d?[\\s-]?\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{2})\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Belgian phone number (mobile 04xx or landline)",
        "examples": [
          "+32 475 12 34 56",
          "02 123 45 67"
        ]
      },
      {
        "id": "regex:be:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b[1-9]\\d{3}\\s+[\\p{L}][\\p{L}\\s'-]+\\b",
        "flags": "gu",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Belgian postal code (4 digits, 1000-9999) followed by city name",
        "examples": [
          "1000 Bruxelles",
          "2000 Antwerpen",
          "9000 Gent"
        ],
        "falsePositiveNotes": "4-digit numbers are common"
      },
      {
        "id": "regex:be:street",
        "entityType": "ADDRESS",
        "pattern": "(?:straat|laan|weg|plein|steenweg|lei|dreef|boulevard|avenue|rue|place|chaussée)[\\p{L}\\s'-]+\\d{1,5}[\\p{L}]?|[\\p{L}][\\p{L}\\s'-]*(?:straat|laan|weg|plein|steenweg|lei|dreef)\\s+\\d{1,5}[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Belgian street address (Dutch/French street types + number)",
        "examples": [
          "Kerkstraat 12",
          "Avenue Louise 54",
          "Rue de la Loi 16"
        ]
      }
    ]
  },
  {
    "region": "at",
    "rules": [
      {
        "id": "regex:at:svnr",
        "entityType": "SSN",
        "pattern": "\\b[1-9]\\d{3}\\s?(?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{2}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Austrian social insurance number (SVNR / Sozialversicherungsnummer, 10 digits)",
        "examples": [
          "1237 010180"
        ],
        "validate": "svnr"
      },
      {
        "id": "regex:at:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?43[\\s-]?|0)\\d{1,4}[\\s-]?\\d{4,10}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Austrian phone number (variable-length area codes)",
        "examples": [
          "+43 1 12345678",
          "0664 1234567"
        ]
      },
      {
        "id": "regex:at:postal",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Austrian postal code (4 digits) followed by city name",
        "examples": [
          "1010 Wien",
          "5020 Salzburg",
          "8010 Graz"
        ]
      },
      {
        "id": "regex:at:street",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s-]*(?:straße|strasse|str\\.|gasse|weg|platz|ring|allee)\\s+\\d+[\\p{L}]?(?:\\s*[/\\\\]\\s*\\d+)?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Austrian street address (name + Straße/Gasse/Weg/Platz + number)",
        "examples": [
          "Mariahilfer Straße 45",
          "Währinger Str. 12",
          "Hauptplatz 1",
          "Neubaugasse 7/3"
        ]
      }
    ]
  },
  {
    "region": "ch",
    "rules": [
      {
        "id": "regex:ch:ahv-avs-number",
        "entityType": "SSN",
        "pattern": "\\b756[.\\s]?\\d{4}[.\\s]?\\d{4}[.\\s]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.95,
        "domains": [
          "identity",
          "hr",
          "medical"
        ],
        "description": "Swiss AHV/AVS social security number (new format, EAN-13 based)",
        "examples": [
          "756.1234.5678.97"
        ],
        "validate": "ahv"
      },
      {
        "id": "regex:ch:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?41[\\s-]?|0)[1-9]\\d[\\s-]?\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Swiss phone number"
      },
      {
        "id": "regex:ch:postal-city",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Swiss postal code followed by city name"
      },
      {
        "id": "regex:ch:street-german",
        "entityType": "ADDRESS",
        "pattern": "[\\p{L}][\\p{L}\\s-]*(?:strasse|str\\.|weg|gasse|platz|allee|rain|matte)\\s+\\d+[\\p{L}]?",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Swiss street address in German (e.g. Bahnhofstrasse 10)"
      },
      {
        "id": "regex:ch:street-french",
        "entityType": "ADDRESS",
        "pattern": "(?:rue|avenue|chemin|route|place|boulevard)\\s+[\\p{L}][\\p{L}\\s'-]+\\s*\\d+",
        "flags": "giu",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "Swiss street address in French (e.g. rue de Lausanne 12)"
      }
    ]
  },
  {
    "region": "ie",
    "rules": [
      {
        "id": "regex:ie:pps-number",
        "entityType": "SSN",
        "pattern": "\\b\\d{7}[A-W][ABWTXZ]?\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr"
        ],
        "description": "Irish PPS (Personal Public Service) number",
        "examples": [
          "1234567T",
          "1234567TW"
        ],
        "validate": "pps"
      },
      {
        "id": "regex:ie:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?353[\\s-]?|0)[1-9]\\d?[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Irish phone number"
      },
      {
        "id": "regex:ie:eircode",
        "entityType": "ADDRESS",
        "pattern": "\\b[A-Z]\\d{2}\\s?[A-Z0-9]{4}\\b",
        "flags": "gi",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Irish Eircode postal code",
        "examples": [
          "A65 F4E2",
          "D08YX4T"
        ]
      }
    ]
  },
  {
    "region": "dk",
    "rules": [
      {
        "id": "regex:dk:cpr-number",
        "entityType": "SSN",
        "pattern": "\\b(?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{2}[-\\s]?\\d{4}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "identity",
          "hr"
        ],
        "description": "Danish CPR (Central Person Register) number",
        "examples": [
          "010190-1234"
        ],
        "falsePositiveNotes": "Post-2007 CPR numbers may not satisfy modulo-11 check"
      },
      {
        "id": "regex:dk:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?45[\\s-]?)?\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}[\\s-]?\\d{2}\\b",
        "flags": "g",
        "confidence": 0.75,
        "domains": [
          "contact"
        ],
        "description": "Danish phone number"
      },
      {
        "id": "regex:dk:postal-city",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{4}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Danish postal code followed by city name"
      }
    ]
  },
  {
    "region": "fi",
    "rules": [
      {
        "id": "regex:fi:hetu",
        "entityType": "SSN",
        "pattern": "\\b(?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{2}[ABCDEFYXWVU+-]\\d{3}[\\dA-FHJK-NPR-Y]\\b",
        "flags": "gi",
        "confidence": 0.9,
        "domains": [
          "identity",
          "hr"
        ],
        "description": "Finnish personal identity code (henkilötunnus / HETU)",
        "examples": [
          "131052-308T"
        ],
        "validate": "hetu"
      },
      {
        "id": "regex:fi:phone",
        "entityType": "PHONE",
        "pattern": "\\b(?:\\+?358[\\s-]?|0)[1-9]\\d?[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Finnish phone number"
      },
      {
        "id": "regex:fi:postal-city",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}\\s+[\\p{L}][\\p{L}\\s-]+\\b",
        "flags": "gu",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "Finnish postal code followed by city name"
      }
    ]
  },
  {
    "region": "us",
    "rules": [
      {
        "id": "regex:us:ssn",
        "entityType": "SSN",
        "pattern": "\\b(?!000|666|9\\d{2})[0-8]\\d{2}-(?!00)\\d{2}-(?!0000)\\d{4}\\b",
        "flags": "g",
        "confidence": 0.92,
        "domains": [
          "identity",
          "hr",
          "financial"
        ],
        "description": "US Social Security Number (SSA-valid ranges, hyphenated)",
        "examples": [
          "123-45-6789",
          "078-05-1120"
        ],
        "falsePositiveNotes": "Hyphenated form only — un-hyphenated SSNs are indistinguishable from other 9-digit IDs."
      },
      {
        "id": "regex:us:itin",
        "entityType": "SSN",
        "pattern": "\\b9\\d{2}-(?:5\\d|6[0-5]|7\\d|8[0-8]|9[0-24-9])-\\d{4}\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "identity",
          "financial"
        ],
        "description": "US IRS Individual Taxpayer Identification Number (ITIN)",
        "examples": [
          "912-70-1234",
          "987-88-4321"
        ]
      },
      {
        "id": "regex:us:ein",
        "entityType": "SSN",
        "pattern": "\\b(?:0[1-6]|1[0-6]|2[0-7]|[35]\\d|[468][0-8]|7[1-7]|9[0-58-9])-\\d{7}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "financial",
          "legal"
        ],
        "description": "US IRS Employer Identification Number (EIN)",
        "examples": [
          "12-3456789",
          "87-6543210"
        ]
      },
      {
        "id": "regex:us:passport",
        "entityType": "SSN",
        "pattern": "\\b[A-Z]?\\d{8,9}\\b",
        "flags": "g",
        "confidence": 0.35,
        "domains": [
          "identity"
        ],
        "description": "US passport number (9 alphanumerics)",
        "examples": [
          "123456789",
          "A12345678"
        ],
        "falsePositiveNotes": "Very broad — best paired with the word \"passport\" in context."
      },
      {
        "id": "regex:us:mbi",
        "entityType": "SSN",
        "pattern": "\\b[1-9][A-HJ-NP-Z][A-HJ-NP-Z0-9]\\d-?[A-HJ-NP-Z][A-HJ-NP-Z0-9]\\d-?[A-HJ-NP-Z]{2}\\d{2}\\b",
        "flags": "g",
        "confidence": 0.95,
        "domains": [
          "medical",
          "identity"
        ],
        "description": "Medicare Beneficiary Identifier (MBI, replaces SSN-based HICN)",
        "examples": [
          "1EG4-TE5-MK73",
          "1AB2CD3EF45"
        ]
      },
      {
        "id": "regex:us:dea",
        "entityType": "SSN",
        "pattern": "\\b[ABCDEFGHJKLMPRSTUX][A-Z]\\d{7}\\b",
        "flags": "g",
        "confidence": 0.92,
        "domains": [
          "medical"
        ],
        "description": "US DEA registration number (prescriber identifier, with checksum)",
        "examples": [
          "BJ1234563",
          "AS9876547"
        ],
        "validate": "dea"
      },
      {
        "id": "regex:us:npi",
        "entityType": "SSN",
        "pattern": "\\b\\d{10}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "medical"
        ],
        "description": "US National Provider Identifier (NPI, Luhn-validated with 80840 prefix)",
        "examples": [
          "1234567893"
        ],
        "falsePositiveNotes": "Raw 10 digits is broad — Luhn check makes the false-positive rate negligible.",
        "validate": "npi"
      },
      {
        "id": "regex:us:routing",
        "entityType": "OTHER",
        "pattern": "\\b(?:0\\d|1[0-2]|2[1-9]|3[0-2]|6[1-9]|7[0-2]|80)\\d{7}\\b",
        "flags": "g",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "US ABA bank routing number (9 digits, valid prefix + mod-10 checksum)",
        "examples": [
          "021000021",
          "011000015"
        ],
        "validate": "aba"
      },
      {
        "id": "regex:us:phone",
        "entityType": "PHONE",
        "pattern": "(?:\\+1[-.\\s]?)?(?:\\(([2-9]\\d{2})\\)[-.\\s]?|([2-9]\\d{2})[-.\\s])([2-9]\\d{2})[-.\\s](\\d{4})\\b",
        "flags": "g",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "US/NANP phone number (e.g., (555) 555-1234, 555-555-1234, +1 555.555.1234)",
        "examples": [
          "(415) 555-2671",
          "415-555-2671",
          "+1 415 555 2671",
          "415.555.2671"
        ],
        "falsePositiveNotes": "Bare 10-digit runs are excluded to avoid colliding with SSN/account numbers."
      },
      {
        "id": "regex:us:zip_plus4",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{5}-\\d{4}\\b",
        "flags": "g",
        "confidence": 0.8,
        "domains": [
          "contact"
        ],
        "description": "US ZIP+4 postal code",
        "examples": [
          "94103-1741",
          "10001-2345"
        ]
      },
      {
        "id": "regex:us:street",
        "entityType": "ADDRESS",
        "pattern": "\\b\\d{1,5}[A-Z]?\\s+(?:[NSEW]\\.?\\s+|North\\s+|South\\s+|East\\s+|West\\s+)?(?:\\d{1,4}(?:st|nd|rd|th)|[A-Z]\\w*)(?:\\s+(?:\\d{1,4}(?:st|nd|rd|th)|[A-Z]\\w*))*\\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Place|Pl|Square|Sq|Terrace|Ter|Trail|Trl|Parkway|Pkwy|Highway|Hwy|Way|Plaza|Plz|Loop|Alley|Aly|Crossing|Xing|Expressway|Expy|Freeway|Fwy)\\b\\.?",
        "flags": "gi",
        "confidence": 0.85,
        "domains": [
          "contact"
        ],
        "description": "US street address (number + name + USPS suffix)",
        "examples": [
          "1600 Pennsylvania Ave",
          "350 5th Avenue",
          "1 Infinite Loop",
          "742 Evergreen Terrace"
        ]
      },
      {
        "id": "regex:us:currency_words",
        "entityType": "CURRENCY",
        "pattern": "(?:in\\s+(?:the\\s+)?(?:amount|sum)\\s+of|pay(?:able)?(?:\\s+the\\s+(?:amount|sum))?\\s+of)\\s+[\\p{L}\\s-]+(?:dollars?|cents?)\\b",
        "flags": "giu",
        "confidence": 0.9,
        "domains": [
          "financial"
        ],
        "description": "US dollar amount written in words (e.g., \"in the amount of eight thousand five hundred dollars\")",
        "examples": [
          "in the amount of five thousand dollars",
          "payable the sum of two hundred fifty dollars"
        ]
      },
      {
        "id": "regex:us:company",
        "entityType": "COMPANY",
        "pattern": "[\\p{L}][\\p{L}\\s&.']+(?:,?\\s+)?(?:Inc\\.?|LLC|L\\.L\\.C\\.|Corp\\.?|Corporation|Co\\.|Company|Ltd\\.?|LP|L\\.P\\.|LLP|L\\.L\\.P\\.|PLLC|P\\.C\\.)\\b",
        "flags": "gu",
        "confidence": 0.85,
        "domains": [
          "legal",
          "financial"
        ],
        "description": "US company name with legal suffix (Inc, LLC, Corp, etc.)",
        "examples": [
          "Apple Inc.",
          "Acme LLC",
          "Stark Industries Corp",
          "Wayne Enterprises, Inc."
        ]
      }
    ]
  }
];
