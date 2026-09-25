/**
 * @doccloak/core/pdf - simple-font encodings (T207).
 *
 * Code -> glyph-name tables for the predefined simple-font encodings of
 * ISO 32000-1:2008 Annex D: D.2 (StandardEncoding, WinAnsiEncoding,
 * MacRomanEncoding, PDFDocEncoding), D.4 (MacExpertEncoding), D.5 (Symbol)
 * and D.6 (ZapfDingbats). The tables are owned by this module; nothing here
 * depends on the shape of a third-party library.
 *
 * Each table is stored as a run string: an `@XX` token sets the current code
 * (hex), every other token is the glyph name of the current code and advances
 * it by one. Codes never mentioned are undefined (no glyph).
 *
 * Annex D notes applied:
 *  - WinAnsi: unused codes above 040 (octal) map to `bullet` (0x7F, 0x80..0x9F
 *    gaps), 0xA0 is `space` (non-breaking space), 0xAD is `hyphen` (soft hyphen).
 *  - MacRoman: 0xCA is `space`, 0xDB is `currency` (Mac OS Roman shows Euro
 *    there). The 15 Mac OS Roman characters the spec table leaves undefined
 *    (notequal, infinity, lessequal, greaterequal, partialdiff, summation,
 *    product, pi, integral, Omega, radical, approxequal, Delta, lozenge, apple)
 *    are filled in as every major viewer does; they occupy codes that Annex D
 *    leaves unassigned, so no spec-defined code is changed.
 *  - Standard: 0x27 is `quoteright` and 0x60 `quoteleft`; `quotesingle` lives at
 *    0xA9 and `grave` at 0xC1.
 *  - PDFDoc: 0x18..0x1F carry the accents, 0x80..0x9E the typographic block,
 *    0xA0 is `Euro`, 0xAD is undefined (D.3), everything else follows Latin-1.
 *  - Symbol: 0xA0 is `Euro`; 0xF0 (apple) and 0xFF are undefined.
 */

/** 256 entries: the glyph name of the code, or undefined when the code has no glyph. */
export type EncodingTable = ReadonlyArray<string | undefined>;

function table(runs: string): EncodingTable {
  const out: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  let code = 0;
  for (const tok of runs.split(' ')) {
    if (tok === '') continue;
    if (tok.charCodeAt(0) === 0x40 /* @ */) {
      code = parseInt(tok.slice(1), 16);
    } else {
      out[code++] = tok;
    }
  }
  return out;
}

/** Annex D.2, STD column (Adobe standard Latin encoding, the Type 1 built-in default). */
export const STANDARD_ENCODING: EncodingTable = table(
  '@20 space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon ' +
  'semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n ' +
  'o p q r s t u v w x y z braceleft bar braceright asciitilde @A1 exclamdown cent sterling ' +
  'fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft ' +
  'guilsinglright fi fl @B1 endash dagger daggerdbl periodcentered @B6 paragraph bullet ' +
  'quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand @BF questiondown ' +
  '@C1 grave acute circumflex tilde macron breve dotaccent dieresis @CA ring cedilla @CD ' +
  'hungarumlaut ogonek caron emdash @E1 AE @E3 ordfeminine @E8 Lslash Oslash OE ordmasculine @F1 ae ' +
  '@F5 dotlessi @F8 lslash oslash oe germandbls',
);

/** Annex D.2, WIN column (Windows code page 1252 as used by PDF). */
export const WIN_ANSI_ENCODING: EncodingTable = table(
  '@20 space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon ' +
  'semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p ' +
  'q r s t u v w x y z braceleft bar braceright asciitilde bullet Euro bullet quotesinglbase florin ' +
  'quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE bullet ' +
  'Zcaron bullet bullet quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde ' +
  'trademark scaron guilsinglright oe bullet zcaron Ydieresis space exclamdown cent sterling ' +
  'currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen ' +
  'registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered ' +
  'cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown ' +
  'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis ' +
  'Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis ' +
  'multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute ' +
  'acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute ' +
  'icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave ' +
  'uacute ucircumflex udieresis yacute thorn ydieresis',
);

/** Annex D.2, MAC column (Mac OS Roman as used by PDF, see the module note). */
export const MAC_ROMAN_ENCODING: EncodingTable = table(
  '@20 space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon ' +
  'semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p ' +
  'q r s t u v w x y z braceleft bar braceright asciitilde @80 Adieresis Aring Ccedilla Eacute ' +
  'Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute ' +
  'egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ' +
  'ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling ' +
  'section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE ' +
  'Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi ' +
  'integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical ' +
  'florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe ' +
  'endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis ' +
  'fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase ' +
  'quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex ' +
  'Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex ' +
  'tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron',
);

/** Annex D.4 (expert character set: small caps, old-style figures, superiors...). */
export const MAC_EXPERT_ENCODING: EncodingTable = table(
  '@20 space exclamsmall Hungarumlautsmall centoldstyle dollaroldstyle dollarsuperior ' +
  'ampersandsmall Acutesmall parenleftsuperior parenrightsuperior twodotenleader onedotenleader ' +
  'comma hyphen period fraction zerooldstyle oneoldstyle twooldstyle threeoldstyle fouroldstyle ' +
  'fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle colon semicolon @3D ' +
  'threequartersemdash @3F questionsmall @44 Ethsmall @47 onequarter onehalf threequarters ' +
  'oneeighth threeeighths fiveeighths seveneighths onethird twothirds @56 ff fi fl ffi ffl ' +
  'parenleftinferior @5D parenrightinferior Circumflexsmall hypheninferior Gravesmall Asmall Bsmall ' +
  'Csmall Dsmall Esmall Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall ' +
  'Psmall Qsmall Rsmall Ssmall Tsmall Usmall Vsmall Wsmall Xsmall Ysmall Zsmall colonmonetary ' +
  'onefitted rupiah Tildesmall @81 asuperior centsuperior @87 Aacutesmall Agravesmall ' +
  'Acircumflexsmall Adieresissmall Atildesmall Aringsmall Ccedillasmall Eacutesmall Egravesmall ' +
  'Ecircumflexsmall Edieresissmall Iacutesmall Igravesmall Icircumflexsmall Idieresissmall ' +
  'Ntildesmall Oacutesmall Ogravesmall Ocircumflexsmall Odieresissmall Otildesmall Uacutesmall ' +
  'Ugravesmall Ucircumflexsmall Udieresissmall @A1 eightsuperior fourinferior threeinferior ' +
  'sixinferior eightinferior seveninferior Scaronsmall @A9 centinferior twoinferior @AC ' +
  'Dieresissmall @AE Caronsmall osuperior fiveinferior @B2 commainferior periodinferior Yacutesmall ' +
  '@B6 dollarinferior @B9 Thornsmall @BB nineinferior zeroinferior Zcaronsmall AEsmall Oslashsmall ' +
  'questiondownsmall oneinferior Lslashsmall @C9 Cedillasmall @CF OEsmall figuredash hyphensuperior ' +
  '@D6 exclamdownsmall @D8 Ydieresissmall @DA onesuperior twosuperior threesuperior foursuperior ' +
  'fivesuperior sixsuperior sevensuperior ninesuperior zerosuperior @E4 esuperior rsuperior ' +
  'tsuperior @E9 isuperior ssuperior dsuperior @F1 lsuperior Ogoneksmall Brevesmall Macronsmall ' +
  'bsuperior nsuperior msuperior commasuperior periodsuperior Dotaccentsmall Ringsmall',
);

/** Annex D.2 PDF column plus D.3 (the encoding of text strings outside content streams). */
export const PDF_DOC_ENCODING: EncodingTable = table(
  '@18 breve caron circumflex dotaccent hungarumlaut ogonek ring tilde space exclam quotedbl ' +
  'numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen ' +
  'period slash zero one two three four five six seven eight nine colon semicolon less equal ' +
  'greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash ' +
  'bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z ' +
  'braceleft bar braceright asciitilde @80 bullet dagger daggerdbl ellipsis emdash endash florin ' +
  'fraction guilsinglleft guilsinglright minus perthousand quotedblbase quotedblleft quotedblright ' +
  'quoteleft quoteright quotesinglbase trademark fi fl Lslash OE Scaron Ydieresis Zcaron dotlessi ' +
  'lslash oe scaron zcaron @A0 Euro exclamdown cent sterling currency yen brokenbar section ' +
  'dieresis copyright ordfeminine guillemotleft logicalnot @AE registered macron degree plusminus ' +
  'twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine ' +
  'guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde ' +
  'Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex ' +
  'Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute ' +
  'Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ' +
  'ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ' +
  'ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis ' +
  'yacute thorn ydieresis',
);

/** Annex D.5: built-in encoding of the standard Symbol font. */
export const SYMBOL_ENCODING: EncodingTable = table(
  '@20 space exclam universal numbersign existential percent ampersand suchthat parenleft ' +
  'parenright asteriskmath plus comma minus period slash zero one two three four five six seven ' +
  'eight nine colon semicolon less equal greater question congruent Alpha Beta Chi Delta Epsilon ' +
  'Phi Gamma Eta Iota theta1 Kappa Lambda Mu Nu Omicron Pi Theta Rho Sigma Tau Upsilon sigma1 Omega ' +
  'Xi Psi Zeta bracketleft therefore bracketright perpendicular underscore radicalex alpha beta chi ' +
  'delta epsilon phi gamma eta iota phi1 kappa lambda mu nu omicron pi theta rho sigma tau upsilon ' +
  'omega1 omega xi psi zeta braceleft bar braceright similar @A0 Euro Upsilon1 minute lessequal ' +
  'fraction infinity florin club diamond heart spade arrowboth arrowleft arrowup arrowright ' +
  'arrowdown degree plusminus second greaterequal multiply proportional partialdiff bullet divide ' +
  'notequal equivalence approxequal ellipsis arrowvertex arrowhorizex carriagereturn aleph Ifraktur ' +
  'Rfraktur weierstrass circlemultiply circleplus emptyset intersection union propersuperset ' +
  'reflexsuperset notsubset propersubset reflexsubset element notelement angle gradient ' +
  'registerserif copyrightserif trademarkserif product radical dotmath logicalnot logicaland ' +
  'logicalor arrowdblboth arrowdblleft arrowdblup arrowdblright arrowdbldown lozenge angleleft ' +
  'registersans copyrightsans trademarksans summation parenlefttp parenleftex parenleftbt ' +
  'bracketlefttp bracketleftex bracketleftbt bracelefttp braceleftmid braceleftbt braceex @F1 ' +
  'angleright integral integraltp integralex integralbt parenrighttp parenrightex parenrightbt ' +
  'bracketrighttp bracketrightex bracketrightbt bracerighttp bracerightmid bracerightbt',
);

/** Annex D.6: built-in encoding of the standard ZapfDingbats font. */
export const ZAPF_DINGBATS_ENCODING: EncodingTable = table(
  '@20 space a1 a2 a202 a3 a4 a5 a119 a118 a117 a11 a12 a13 a14 a15 a16 a105 a17 a18 a19 a20 a21 ' +
  'a22 a23 a24 a25 a26 a27 a28 a6 a7 a8 a9 a10 a29 a30 a31 a32 a33 a34 a35 a36 a37 a38 a39 a40 a41 ' +
  'a42 a43 a44 a45 a46 a47 a48 a49 a50 a51 a52 a53 a54 a55 a56 a57 a58 a59 a60 a61 a62 a63 a64 a65 ' +
  'a66 a67 a68 a69 a70 a71 a72 a73 a74 a203 a75 a204 a76 a77 a78 a79 a81 a82 a83 a84 a97 a98 a99 ' +
  'a100 @80 a89 a90 a93 a94 a91 a92 a205 a85 a206 a86 a87 a88 a95 a96 @A1 a101 a102 a103 a104 a106 ' +
  'a107 a108 a112 a111 a110 a109 a120 a121 a122 a123 a124 a125 a126 a127 a128 a129 a130 a131 a132 ' +
  'a133 a134 a135 a136 a137 a138 a139 a140 a141 a142 a143 a144 a145 a146 a147 a148 a149 a150 a151 ' +
  'a152 a153 a154 a155 a156 a157 a158 a159 a160 a161 a163 a164 a196 a165 a192 a166 a167 a168 a169 ' +
  'a170 a171 a172 a173 a162 a174 a175 a176 a177 a178 a179 a193 a180 a199 a181 a200 a182 @F1 a201 ' +
  'a183 a184 a197 a185 a194 a198 a186 a195 a187 a188 a189 a190 a191',
);

/**
 * Resolves a predefined encoding name as used in a font dictionary's
 * `/Encoding` entry (or `/BaseEncoding`). Returns undefined for any other name.
 */
export function encodingByName(name: string): EncodingTable | undefined {
  switch (name) {
    case 'StandardEncoding':
      return STANDARD_ENCODING;
    case 'WinAnsiEncoding':
      return WIN_ANSI_ENCODING;
    case 'MacRomanEncoding':
      return MAC_ROMAN_ENCODING;
    case 'MacExpertEncoding':
      return MAC_EXPERT_ENCODING;
    default:
      return undefined;
  }
}
