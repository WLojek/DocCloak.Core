/**
 * @doccloak/core/pdf - Adobe Glyph List (T207).
 *
 * Glyph name -> Unicode for simple fonts whose encoding is expressed as glyph
 * names (Annex D tables, /Differences arrays, Type 1 built-in encodings), and
 * the reverse lookup used to check whether a placeholder can be encoded in a
 * document font.
 *
 * The table is a subset of the Adobe Glyph List 2.0 (aglfn + AGL) chosen for
 * European text: Basic Latin, Latin-1, Latin Extended-A/B and Additional,
 * spacing modifiers, Greek, Cyrillic (afii names), general punctuation,
 * super/subscripts, currency, letterlike, number forms, arrows, mathematical
 * operators, technical, blocks, geometric shapes, miscellaneous symbols and
 * dingbats, the fi/fl/ff/ffi/ffl/st presentation forms, the Adobe corporate
 * use area (small caps, superiors, Symbol font extenders), every name used by
 * the Annex D encodings, and the ITC Zapf Dingbats list (a1..a191). Hebrew,
 * Arabic, Thai, CJK and Hangul names are left out on purpose.
 *
 * Name resolution follows the AGL specification (section 3 "Mapping glyph
 * names to Unicode"): strip everything from the first period, split ligature
 * components on underscore, then per component: AGL lookup, `uniXXXX[YYYY...]`
 * (4-digit groups, BMP, no surrogates), `uXXXX`..`uXXXXXX`. Anything else
 * (`g12`, `cid12`, `glyph12`, `G12`, `.notdef`) yields undefined.
 */

import {
  MAC_ROMAN_ENCODING,
  PDF_DOC_ENCODING,
  STANDARD_ENCODING,
  SYMBOL_ENCODING,
  WIN_ANSI_ENCODING,
  ZAPF_DINGBATS_ENCODING,
} from './encodings.ts';

/** 'name:HEX;name:HEX;...' in AGL order (ASCII sort), dingbats names appended. Parsed lazily once. */
const AGL_DATA =
  'A:41;AE:C6;AEacute:1FC;AEmacron:1E2;AEsmall:F7E6;Aacute:C1;Aacutesmall:F7E1;Abreve:102;' +
  'Abreveacute:1EAE;Abrevecyrillic:4D0;Abrevedotbelow:1EB6;Abrevegrave:1EB0;Abrevehookabove:1EB2;' +
  'Abrevetilde:1EB4;Acaron:1CD;Acircumflex:C2;Acircumflexacute:1EA4;Acircumflexdotbelow:1EAC;' +
  'Acircumflexgrave:1EA6;Acircumflexhookabove:1EA8;Acircumflexsmall:F7E2;Acircumflextilde:1EAA;' +
  'Acute:F6C9;Acutesmall:F7B4;Acyrillic:410;Adblgrave:200;Adieresis:C4;Adieresiscyrillic:4D2;' +
  'gravecomb:300;acutecomb:301;tildecomb:303;hookabovecomb:309;dotbelowcomb:323;Adieresismacron:1DE;Adieresissmall:F7E4;Adotbelow:1EA0;Adotmacron:1E0;Agrave:C0;Agravesmall:F7E0;' +
  'Ahookabove:1EA2;Aiecyrillic:4D4;Ainvertedbreve:202;Alpha:391;Alphatonos:386;Amacron:100;Aogonek:104;' +
  'Aring:C5;Aringacute:1FA;Aringbelow:1E00;Aringsmall:F7E5;Asmall:F761;Atilde:C3;Atildesmall:F7E3;B:42;' +
  'Bdotaccent:1E02;Bdotbelow:1E04;Becyrillic:411;Beta:392;Bhook:181;Blinebelow:1E06;Brevesmall:F6F4;' +
  'Bsmall:F762;Btopbar:182;C:43;Cacute:106;Caron:F6CA;Caronsmall:F6F5;Ccaron:10C;Ccedilla:C7;' +
  'Ccedillaacute:1E08;Ccedillasmall:F7E7;Ccircumflex:108;Cdot:10A;Cdotaccent:10A;Cedillasmall:F7B8;' +
  'Cheabkhasiancyrillic:4BC;Checyrillic:427;Chedescenderabkhasiancyrillic:4BE;Chedescendercyrillic:4B6;' +
  'Chedieresiscyrillic:4F4;Chekhakassiancyrillic:4CB;Cheverticalstrokecyrillic:4B8;Chi:3A7;Chook:187;' +
  'Circumflexsmall:F6F6;Csmall:F763;D:44;DZ:1F1;DZcaron:1C4;Dafrican:189;Dcaron:10E;Dcedilla:1E10;' +
  'Dcircumflexbelow:1E12;Dcroat:110;Ddotaccent:1E0A;Ddotbelow:1E0C;Decyrillic:414;Deicoptic:3EE;' +
  'Delta:2206;Deltagreek:394;Dhook:18A;Dieresis:F6CB;DieresisAcute:F6CC;DieresisGrave:F6CD;' +
  'Dieresissmall:F7A8;Digammagreek:3DC;Djecyrillic:402;Dlinebelow:1E0E;Dotaccentsmall:F6F7;Dslash:110;' +
  'Dsmall:F764;Dtopbar:18B;Dz:1F2;Dzcaron:1C5;Dzeabkhasiancyrillic:4E0;Dzecyrillic:405;Dzhecyrillic:40F;' +
  'E:45;Eacute:C9;Eacutesmall:F7E9;Ebreve:114;Ecaron:11A;Ecedillabreve:1E1C;Ecircumflex:CA;' +
  'Ecircumflexacute:1EBE;Ecircumflexbelow:1E18;Ecircumflexdotbelow:1EC6;Ecircumflexgrave:1EC0;' +
  'Ecircumflexhookabove:1EC2;Ecircumflexsmall:F7EA;Ecircumflextilde:1EC4;Ecyrillic:404;Edblgrave:204;' +
  'Edieresis:CB;Edieresissmall:F7EB;Edot:116;Edotaccent:116;Edotbelow:1EB8;Efcyrillic:424;Egrave:C8;' +
  'Egravesmall:F7E8;Ehookabove:1EBA;Eightroman:2167;Einvertedbreve:206;Eiotifiedcyrillic:464;' +
  'Elcyrillic:41B;Elevenroman:216A;Emacron:112;Emacronacute:1E16;Emacrongrave:1E14;Emcyrillic:41C;' +
  'Encyrillic:41D;Endescendercyrillic:4A2;Eng:14A;Enghecyrillic:4A4;Enhookcyrillic:4C7;Eogonek:118;' +
  'Eopen:190;Epsilon:395;Epsilontonos:388;Ercyrillic:420;Ereversed:18E;Ereversedcyrillic:42D;' +
  'Escyrillic:421;Esdescendercyrillic:4AA;Esh:1A9;Esmall:F765;Eta:397;Etatonos:389;Eth:D0;Ethsmall:F7F0;' +
  'Etilde:1EBC;Etildebelow:1E1A;Euro:20AC;Ezh:1B7;Ezhcaron:1EE;Ezhreversed:1B8;F:46;Fdotaccent:1E1E;' +
  'Feicoptic:3E4;Fhook:191;Fitacyrillic:472;Fiveroman:2164;Fourroman:2163;Fsmall:F766;G:47;Gacute:1F4;' +
  'Gamma:393;Gammaafrican:194;Gangiacoptic:3EA;Gbreve:11E;Gcaron:1E6;Gcedilla:122;Gcircumflex:11C;' +
  'Gcommaaccent:122;Gdot:120;Gdotaccent:120;Gecyrillic:413;Ghemiddlehookcyrillic:494;' +
  'Ghestrokecyrillic:492;Gheupturncyrillic:490;Ghook:193;Gjecyrillic:403;Gmacron:1E20;Grave:F6CE;' +
  'Gravesmall:F760;Gsmall:F767;Gstroke:1E4;H:48;H18533:25CF;H18543:25AA;H18551:25AB;H22073:25A1;' +
  'Haabkhasiancyrillic:4A8;Hadescendercyrillic:4B2;Hardsigncyrillic:42A;Hbar:126;Hbrevebelow:1E2A;' +
  'Hcedilla:1E28;Hcircumflex:124;Hdieresis:1E26;Hdotaccent:1E22;Hdotbelow:1E24;Horicoptic:3E8;' +
  'Hsmall:F768;Hungarumlaut:F6CF;Hungarumlautsmall:F6F8;I:49;IAcyrillic:42F;IJ:132;IUcyrillic:42E;' +
  'Iacute:CD;Iacutesmall:F7ED;Ibreve:12C;Icaron:1CF;Icircumflex:CE;Icircumflexsmall:F7EE;Icyrillic:406;' +
  'Idblgrave:208;Idieresis:CF;Idieresisacute:1E2E;Idieresiscyrillic:4E4;Idieresissmall:F7EF;Idot:130;' +
  'Idotaccent:130;Idotbelow:1ECA;Iebrevecyrillic:4D6;Iecyrillic:415;Ifraktur:2111;Igrave:CC;' +
  'Igravesmall:F7EC;Ihookabove:1EC8;Iicyrillic:418;Iinvertedbreve:20A;Iishortcyrillic:419;Imacron:12A;' +
  'Imacroncyrillic:4E2;Iocyrillic:401;Iogonek:12E;Iota:399;Iotaafrican:196;Iotadieresis:3AA;' +
  'Iotatonos:38A;Ismall:F769;Istroke:197;Itilde:128;Itildebelow:1E2C;Izhitsacyrillic:474;' +
  'Izhitsadblgravecyrillic:476;J:4A;Jcircumflex:134;Jecyrillic:408;Jsmall:F76A;K:4B;' +
  'Kabashkircyrillic:4A0;Kacute:1E30;Kacyrillic:41A;Kadescendercyrillic:49A;Kahookcyrillic:4C3;' +
  'Kappa:39A;Kastrokecyrillic:49E;Kaverticalstrokecyrillic:49C;Kcaron:1E8;Kcedilla:136;Kcommaaccent:136;' +
  'Kdotbelow:1E32;Khacyrillic:425;Kheicoptic:3E6;Khook:198;Kjecyrillic:40C;Klinebelow:1E34;' +
  'Koppacyrillic:480;Koppagreek:3DE;Ksicyrillic:46E;Ksmall:F76B;L:4C;LJ:1C7;LL:F6BF;Lacute:139;' +
  'Lambda:39B;Lcaron:13D;Lcedilla:13B;Lcircumflexbelow:1E3C;Lcommaaccent:13B;Ldot:13F;Ldotaccent:13F;' +
  'Ldotbelow:1E36;Ldotbelowmacron:1E38;Lj:1C8;Ljecyrillic:409;Llinebelow:1E3A;Lslash:141;' +
  'Lslashsmall:F6F9;Lsmall:F76C;M:4D;Macron:F6D0;Macronsmall:F7AF;Macute:1E3E;Mdotaccent:1E40;' +
  'Mdotbelow:1E42;Msmall:F76D;Mturned:19C;Mu:39C;N:4E;NJ:1CA;Nacute:143;Ncaron:147;Ncedilla:145;' +
  'Ncircumflexbelow:1E4A;Ncommaaccent:145;Ndotaccent:1E44;Ndotbelow:1E46;Nhookleft:19D;Nineroman:2168;' +
  'Nj:1CB;Njecyrillic:40A;Nlinebelow:1E48;Nsmall:F76E;Ntilde:D1;Ntildesmall:F7F1;Nu:39D;O:4F;OE:152;' +
  'OEsmall:F6FA;Oacute:D3;Oacutesmall:F7F3;Obarredcyrillic:4E8;Obarreddieresiscyrillic:4EA;Obreve:14E;' +
  'Ocaron:1D1;Ocenteredtilde:19F;Ocircumflex:D4;Ocircumflexacute:1ED0;Ocircumflexdotbelow:1ED8;' +
  'Ocircumflexgrave:1ED2;Ocircumflexhookabove:1ED4;Ocircumflexsmall:F7F4;Ocircumflextilde:1ED6;' +
  'Ocyrillic:41E;Odblacute:150;Odblgrave:20C;Odieresis:D6;Odieresiscyrillic:4E6;Odieresissmall:F7F6;' +
  'Odotbelow:1ECC;Ogoneksmall:F6FB;Ograve:D2;Ogravesmall:F7F2;Ohm:2126;Ohookabove:1ECE;Ohorn:1A0;' +
  'Ohornacute:1EDA;Ohorndotbelow:1EE2;Ohorngrave:1EDC;Ohornhookabove:1EDE;Ohorntilde:1EE0;' +
  'Ohungarumlaut:150;Oi:1A2;Oinvertedbreve:20E;Omacron:14C;Omacronacute:1E52;Omacrongrave:1E50;' +
  'Omega:2126;Omegacyrillic:460;Omegagreek:3A9;Omegaroundcyrillic:47A;Omegatitlocyrillic:47C;' +
  'Omegatonos:38F;Omicron:39F;Omicrontonos:38C;Oneroman:2160;Oogonek:1EA;Oogonekmacron:1EC;Oopen:186;' +
  'Oslash:D8;Oslashacute:1FE;Oslashsmall:F7F8;Osmall:F76F;Ostrokeacute:1FE;Otcyrillic:47E;Otilde:D5;' +
  'Otildeacute:1E4C;Otildedieresis:1E4E;Otildesmall:F7F5;P:50;Pacute:1E54;Pdotaccent:1E56;' +
  'Pecyrillic:41F;Pemiddlehookcyrillic:4A6;Phi:3A6;Phook:1A4;Pi:3A0;Psi:3A8;Psicyrillic:470;Psmall:F770;' +
  'Q:51;Qsmall:F771;R:52;Racute:154;Rcaron:158;Rcedilla:156;Rcommaaccent:156;Rdblgrave:210;' +
  'Rdotaccent:1E58;Rdotbelow:1E5A;Rdotbelowmacron:1E5C;Rfraktur:211C;Rho:3A1;Ringsmall:F6FC;' +
  'Rinvertedbreve:212;Rlinebelow:1E5E;Rsmall:F772;Rsmallinvertedsuperior:2B6;S:53;Sacute:15A;' +
  'Sacutedotaccent:1E64;Sampigreek:3E0;Scaron:160;Scarondotaccent:1E66;Scaronsmall:F6FD;Scedilla:15E;' +
  'Schwa:18F;Schwacyrillic:4D8;Schwadieresiscyrillic:4DA;Scircumflex:15C;Scommaaccent:218;' +
  'Sdotaccent:1E60;Sdotbelow:1E62;Sdotbelowdotaccent:1E68;Sevenroman:2166;Shacyrillic:428;' +
  'Shchacyrillic:429;Sheicoptic:3E2;Shhacyrillic:4BA;Shimacoptic:3EC;Sigma:3A3;Sixroman:2165;' +
  'Softsigncyrillic:42C;Ssmall:F773;Stigmagreek:3DA;T:54;Tau:3A4;Tbar:166;Tcaron:164;Tcedilla:162;' +
  'Tcircumflexbelow:1E70;Tcommaaccent:162;Tdotaccent:1E6A;Tdotbelow:1E6C;Tecyrillic:422;' +
  'Tedescendercyrillic:4AC;Tenroman:2169;Tetsecyrillic:4B4;Theta:398;Thook:1AC;Thorn:DE;Thornsmall:F7FE;' +
  'Threeroman:2162;Tildesmall:F6FE;Tlinebelow:1E6E;Tonefive:1BC;Tonesix:184;Tonetwo:1A7;' +
  'Tretroflexhook:1AE;Tsecyrillic:426;Tshecyrillic:40B;Tsmall:F774;Twelveroman:216B;Tworoman:2161;U:55;' +
  'Uacute:DA;Uacutesmall:F7FA;Ubreve:16C;Ucaron:1D3;Ucircumflex:DB;Ucircumflexbelow:1E76;' +
  'Ucircumflexsmall:F7FB;Ucyrillic:423;Udblacute:170;Udblgrave:214;Udieresis:DC;Udieresisacute:1D7;' +
  'Udieresisbelow:1E72;Udieresiscaron:1D9;Udieresiscyrillic:4F0;Udieresisgrave:1DB;Udieresismacron:1D5;' +
  'Udieresissmall:F7FC;Udotbelow:1EE4;Ugrave:D9;Ugravesmall:F7F9;Uhookabove:1EE6;Uhorn:1AF;' +
  'Uhornacute:1EE8;Uhorndotbelow:1EF0;Uhorngrave:1EEA;Uhornhookabove:1EEC;Uhorntilde:1EEE;' +
  'Uhungarumlaut:170;Uhungarumlautcyrillic:4F2;Uinvertedbreve:216;Ukcyrillic:478;Umacron:16A;' +
  'Umacroncyrillic:4EE;Umacrondieresis:1E7A;Uogonek:172;Upsilon:3A5;Upsilon1:3D2;' +
  'Upsilonacutehooksymbolgreek:3D3;Upsilonafrican:1B1;Upsilondieresis:3AB;' +
  'Upsilondieresishooksymbolgreek:3D4;Upsilonhooksymbol:3D2;Upsilontonos:38E;Uring:16E;' +
  'Ushortcyrillic:40E;Usmall:F775;Ustraightcyrillic:4AE;Ustraightstrokecyrillic:4B0;Utilde:168;' +
  'Utildeacute:1E78;Utildebelow:1E74;V:56;Vdotbelow:1E7E;Vecyrillic:412;Vhook:1B2;Vsmall:F776;' +
  'Vtilde:1E7C;W:57;Wacute:1E82;Wcircumflex:174;Wdieresis:1E84;Wdotaccent:1E86;Wdotbelow:1E88;' +
  'Wgrave:1E80;Wsmall:F777;X:58;Xdieresis:1E8C;Xdotaccent:1E8A;Xi:39E;Xsmall:F778;Y:59;Yacute:DD;' +
  'Yacutesmall:F7FD;Yatcyrillic:462;Ycircumflex:176;Ydieresis:178;Ydieresissmall:F7FF;Ydotaccent:1E8E;' +
  'Ydotbelow:1EF4;Yericyrillic:42B;Yerudieresiscyrillic:4F8;Ygrave:1EF2;Yhook:1B3;Yhookabove:1EF6;' +
  'Yicyrillic:407;Ysmall:F779;Ytilde:1EF8;Yusbigcyrillic:46A;Yusbigiotifiedcyrillic:46C;' +
  'Yuslittlecyrillic:466;Yuslittleiotifiedcyrillic:468;Z:5A;Zacute:179;Zcaron:17D;Zcaronsmall:F6FF;' +
  'Zcircumflex:1E90;Zdot:17B;Zdotaccent:17B;Zdotbelow:1E92;Zecyrillic:417;Zedescendercyrillic:498;' +
  'Zedieresiscyrillic:4DE;Zeta:396;Zhebrevecyrillic:4C1;Zhecyrillic:416;Zhedescendercyrillic:496;' +
  'Zhedieresiscyrillic:4DC;Zlinebelow:1E94;Zsmall:F77A;Zstroke:1B5;a:61;aacute:E1;abreve:103;' +
  'abreveacute:1EAF;abrevecyrillic:4D1;abrevedotbelow:1EB7;abrevegrave:1EB1;abrevehookabove:1EB3;' +
  'abrevetilde:1EB5;acaron:1CE;acircumflex:E2;acircumflexacute:1EA5;acircumflexdotbelow:1EAD;' +
  'acircumflexgrave:1EA7;acircumflexhookabove:1EA9;acircumflextilde:1EAB;acute:B4;acutelowmod:2CF;' +
  'acyrillic:430;adblgrave:201;adieresis:E4;adieresiscyrillic:4D3;adieresismacron:1DF;adotbelow:1EA1;' +
  'adotmacron:1E1;ae:E6;aeacute:1FD;aemacron:1E3;afii00208:2015;afii08941:20A4;afii10017:410;' +
  'afii10018:411;afii10019:412;afii10020:413;afii10021:414;afii10022:415;afii10023:401;afii10024:416;' +
  'afii10025:417;afii10026:418;afii10027:419;afii10028:41A;afii10029:41B;afii10030:41C;afii10031:41D;' +
  'afii10032:41E;afii10033:41F;afii10034:420;afii10035:421;afii10036:422;afii10037:423;afii10038:424;' +
  'afii10039:425;afii10040:426;afii10041:427;afii10042:428;afii10043:429;afii10044:42A;afii10045:42B;' +
  'afii10046:42C;afii10047:42D;afii10048:42E;afii10049:42F;afii10050:490;afii10051:402;afii10052:403;' +
  'afii10053:404;afii10054:405;afii10055:406;afii10056:407;afii10057:408;afii10058:409;afii10059:40A;' +
  'afii10060:40B;afii10061:40C;afii10062:40E;afii10063:F6C4;afii10064:F6C5;afii10065:430;afii10066:431;' +
  'afii10067:432;afii10068:433;afii10069:434;afii10070:435;afii10071:451;afii10072:436;afii10073:437;' +
  'afii10074:438;afii10075:439;afii10076:43A;afii10077:43B;afii10078:43C;afii10079:43D;afii10080:43E;' +
  'afii10081:43F;afii10082:440;afii10083:441;afii10084:442;afii10085:443;afii10086:444;afii10087:445;' +
  'afii10088:446;afii10089:447;afii10090:448;afii10091:449;afii10092:44A;afii10093:44B;afii10094:44C;' +
  'afii10095:44D;afii10096:44E;afii10097:44F;afii10098:491;afii10099:452;afii10100:453;afii10101:454;' +
  'afii10102:455;afii10103:456;afii10104:457;afii10105:458;afii10106:459;afii10107:45A;afii10108:45B;' +
  'afii10109:45C;afii10110:45E;afii10145:40F;afii10146:462;afii10147:472;afii10148:474;afii10192:F6C6;' +
  'afii10193:45F;afii10194:463;afii10195:473;afii10196:475;afii10831:F6C7;afii10832:F6C8;afii10846:4D9;' +
  'afii299:200E;afii300:200F;afii301:200D;afii57636:20AA;afii57929:2BC;afii61248:2105;afii61289:2113;' +
  'afii61352:2116;afii61573:202C;afii61574:202D;afii61575:202E;afii61664:200C;afii64937:2BD;agrave:E0;' +
  'ahookabove:1EA3;aiecyrillic:4D5;ainvertedbreve:203;aleph:2135;allequal:224C;alpha:3B1;alphatonos:3AC;' +
  'amacron:101;ampersand:26;ampersandsmall:F726;angle:2220;angleleft:2329;angleright:232A;angstrom:212B;' +
  'anoteleia:387;aogonek:105;apostrophemod:2BC;apple:F8FF;approaches:2250;approxequal:2248;' +
  'approxequalorimage:2252;approximatelyequal:2245;arc:2312;arighthalfring:1E9A;aring:E5;aringacute:1FB;' +
  'aringbelow:1E01;arrowboth:2194;arrowdashdown:21E3;arrowdashleft:21E0;arrowdashright:21E2;' +
  'arrowdashup:21E1;arrowdblboth:21D4;arrowdbldown:21D3;arrowdblleft:21D0;arrowdblright:21D2;' +
  'arrowdblup:21D1;arrowdown:2193;arrowdownleft:2199;arrowdownright:2198;arrowdownwhite:21E9;' +
  'arrowheaddownmod:2C5;arrowheadleftmod:2C2;arrowheadrightmod:2C3;arrowheadupmod:2C4;arrowhorizex:F8E7;' +
  'arrowleft:2190;arrowleftdbl:21D0;arrowleftdblstroke:21CD;arrowleftoverright:21C6;arrowleftwhite:21E6;' +
  'arrowright:2192;arrowrightdblstroke:21CF;arrowrightheavy:279E;arrowrightoverleft:21C4;' +
  'arrowrightwhite:21E8;arrowtableft:21E4;arrowtabright:21E5;arrowup:2191;arrowupdn:2195;' +
  'arrowupdnbse:21A8;arrowupdownbase:21A8;arrowupleft:2196;arrowupleftofdown:21C5;arrowupright:2197;' +
  'arrowupwhite:21E7;arrowvertex:F8E6;asciicircum:5E;asciitilde:7E;asterisk:2A;asteriskmath:2217;' +
  'asterism:2042;asuperior:F6E9;asymptoticallyequal:2243;at:40;atilde:E3;b:62;backslash:5C;bar:7C;' +
  'bdotaccent:1E03;bdotbelow:1E05;beamedsixteenthnotes:266C;because:2235;becyrillic:431;beta:3B2;' +
  'betasymbolgreek:3D0;blackcircle:25CF;blackdiamond:25C6;blackdownpointingtriangle:25BC;' +
  'blackleftpointingpointer:25C4;blackleftpointingtriangle:25C0;blacklowerlefttriangle:25E3;' +
  'blacklowerrighttriangle:25E2;blackrectangle:25AC;blackrightpointingpointer:25BA;' +
  'blackrightpointingtriangle:25B6;blacksmallsquare:25AA;blacksmilingface:263B;blacksquare:25A0;' +
  'blackstar:2605;blackupperlefttriangle:25E4;blackupperrighttriangle:25E5;' +
  'blackuppointingsmalltriangle:25B4;blackuppointingtriangle:25B2;blinebelow:1E07;block:2588;' +
  'braceex:F8F4;braceleft:7B;braceleftbt:F8F3;braceleftmid:F8F2;bracelefttp:F8F1;braceright:7D;' +
  'bracerightbt:F8FE;bracerightmid:F8FD;bracerighttp:F8FC;bracketleft:5B;bracketleftbt:F8F0;' +
  'bracketleftex:F8EF;bracketlefttp:F8EE;bracketright:5D;bracketrightbt:F8FB;bracketrightex:F8FA;' +
  'bracketrighttp:F8F9;breve:2D8;brokenbar:A6;bstroke:180;bsuperior:F6EA;btopbar:183;bullet:2022;' +
  'bulletinverse:25D8;bulletoperator:2219;bullseye:25CE;c:63;cacute:107;capslock:21EA;careof:2105;' +
  'caron:2C7;carriagereturn:21B5;ccaron:10D;ccedilla:E7;ccedillaacute:1E09;ccircumflex:109;cdot:10B;' +
  'cdotaccent:10B;cedilla:B8;cent:A2;centigrade:2103;centinferior:F6DF;centoldstyle:F7A2;' +
  'centsuperior:F6E0;cheabkhasiancyrillic:4BD;checkmark:2713;checyrillic:447;' +
  'chedescenderabkhasiancyrillic:4BF;chedescendercyrillic:4B7;chedieresiscyrillic:4F5;' +
  'chekhakassiancyrillic:4CC;cheverticalstrokecyrillic:4B9;chi:3C7;chook:188;circle:25CB;' +
  'circlecopyrt:A9;circlemultiply:2297;circleot:2299;circleplus:2295;circlewithlefthalfblack:25D0;' +
  'circlewithrighthalfblack:25D1;circumflex:2C6;clear:2327;clickalveolar:1C2;clickdental:1C0;' +
  'clicklateral:1C1;clickretroflex:1C3;club:2663;clubsuitblack:2663;clubsuitwhite:2667;colon:3A;' +
  'colonmonetary:20A1;colonsign:20A1;colontriangularhalfmod:2D1;colontriangularmod:2D0;comma:2C;' +
  'commaaccent:F6C3;commainferior:F6E1;commareversedmod:2BD;commasuperior:F6E2;commaturnedmod:2BB;' +
  'compass:263C;congruent:2245;contourintegral:222E;control:2303;controlDEL:7F;copyright:A9;' +
  'copyrightsans:F8E9;copyrightserif:F6D9;cruzeiro:20A2;curlyand:22CF;curlyor:22CE;currency:A4;' +
  'cyrBreve:F6D1;cyrFlex:F6D2;cyrbreve:F6D4;cyrflex:F6D5;d:64;dagger:2020;daggerdbl:2021;' +
  'dasiapneumatacyrilliccmb:485;dblGrave:F6D3;dblarrowleft:21D4;dblarrowright:21D2;dblgrave:F6D6;' +
  'dblintegral:222C;dbllowline:2017;dblprimemod:2BA;dblverticalbar:2016;dcaron:10F;dcedilla:1E11;' +
  'dcircumflexbelow:1E13;dcroat:111;ddotaccent:1E0B;ddotbelow:1E0D;decyrillic:434;degree:B0;' +
  'deicoptic:3EF;deleteleft:232B;deleteright:2326;delta:3B4;deltaturned:18D;dialytikatonos:385;' +
  'diamond:2666;diamondsuitwhite:2662;dieresis:A8;dieresisacute:F6D7;dieresisgrave:F6D8;' +
  'dieresistonos:385;divide:F7;divides:2223;divisionslash:2215;djecyrillic:452;dkshade:2593;' +
  'dlinebelow:1E0F;dmacron:111;dnblock:2584;dollar:24;dollarinferior:F6E3;dollaroldstyle:F724;' +
  'dollarsuperior:F6E4;dong:20AB;dotaccent:2D9;dotlessi:131;dotlessj:F6BE;dotmath:22C5;' +
  'dottedcircle:25CC;downtackmod:2D5;dsuperior:F6EB;dtopbar:18C;dz:1F3;dzcaron:1C6;' +
  'dzeabkhasiancyrillic:4E1;dzecyrillic:455;dzhecyrillic:45F;e:65;eacute:E9;earth:2641;ebreve:115;' +
  'ecaron:11B;ecedillabreve:1E1D;ecircumflex:EA;ecircumflexacute:1EBF;ecircumflexbelow:1E19;' +
  'ecircumflexdotbelow:1EC7;ecircumflexgrave:1EC1;ecircumflexhookabove:1EC3;ecircumflextilde:1EC5;' +
  'ecyrillic:454;edblgrave:205;edieresis:EB;edot:117;edotaccent:117;edotbelow:1EB9;efcyrillic:444;' +
  'egrave:E8;ehookabove:1EBB;eight:38;eightcircleinversesansserif:2791;eighthnotebeamed:266B;' +
  'eightinferior:2088;eightoldstyle:F738;eightroman:2177;eightsuperior:2078;einvertedbreve:207;' +
  'eiotifiedcyrillic:465;elcyrillic:43B;element:2208;elevenroman:217A;ellipsis:2026;' +
  'ellipsisvertical:22EE;emacron:113;emacronacute:1E17;emacrongrave:1E15;emcyrillic:43C;emdash:2014;' +
  'emptyset:2205;encyrillic:43D;endash:2013;endescendercyrillic:4A3;eng:14B;enghecyrillic:4A5;' +
  'enhookcyrillic:4C8;enspace:2002;eogonek:119;epsilon:3B5;epsilontonos:3AD;equal:3D;equalsuperior:207C;' +
  'equivalence:2261;ercyrillic:440;ereversedcyrillic:44D;escyrillic:441;esdescendercyrillic:4AB;' +
  'eshreversedloop:1AA;estimated:212E;esuperior:F6EC;eta:3B7;etatonos:3AE;eth:F0;etilde:1EBD;' +
  'etildebelow:1E1B;eturned:1DD;euro:20AC;exclam:21;exclamdbl:203C;exclamdown:A1;exclamdownsmall:F7A1;' +
  'exclamsmall:F721;existential:2203;ezhcaron:1EF;ezhreversed:1B9;ezhtail:1BA;f:66;fahrenheit:2109;' +
  'fdotaccent:1E1F;feicoptic:3E5;female:2640;ff:FB00;f_f:FB00;ffi:FB03;f_f_i:FB03;ffl:FB04;f_f_l:FB04;' +
  'fi:FB01;f_i:FB01;figuredash:2012;filledbox:25A0;filledrect:25AC;firsttonechinese:2C9;fisheye:25C9;' +
  'fitacyrillic:473;five:35;fivecircleinversesansserif:278E;fiveeighths:215D;fiveinferior:2085;' +
  'fiveoldstyle:F735;fiveroman:2174;fivesuperior:2075;fl:FB02;f_l:FB02;florin:192;forall:2200;four:34;' +
  'fourcircleinversesansserif:278D;fourinferior:2084;fouroldstyle:F734;fourroman:2173;foursuperior:2074;' +
  'fourthtonechinese:2CB;fraction:2044;franc:20A3;g:67;gacute:1F5;gamma:3B3;gammasuperior:2E0;' +
  'gangiacoptic:3EB;gbreve:11F;gcaron:1E7;gcedilla:123;gcircumflex:11D;gcommaaccent:123;gdot:121;' +
  'gdotaccent:121;gecyrillic:433;geometricallyequal:2251;germandbls:DF;ghemiddlehookcyrillic:495;' +
  'ghestrokecyrillic:493;gheupturncyrillic:491;gjecyrillic:453;glottalinvertedstroke:1BE;' +
  'glottalstopmod:2C0;glottalstopreversedmod:2C1;glottalstopreversedsuperior:2E4;gmacron:1E21;' +
  'gradient:2207;grave:60;gravelowmod:2CE;greater:3E;greaterequal:2265;greaterequalorless:22DB;' +
  'greaterorequivalent:2273;greaterorless:2277;greateroverequal:2267;gstroke:1E5;guillemotleft:AB;' +
  'guillemotright:BB;guilsinglleft:2039;guilsinglright:203A;h:68;haabkhasiancyrillic:4A9;' +
  'hadescendercyrillic:4B3;hardsigncyrillic:44A;harpoonleftbarbup:21BC;harpoonrightbarbup:21C0;hbar:127;' +
  'hbrevebelow:1E2B;hcedilla:1E29;hcircumflex:125;hdieresis:1E27;hdotaccent:1E23;hdotbelow:1E25;' +
  'heart:2665;heartsuitblack:2665;heartsuitwhite:2661;hhooksuperior:2B1;hlinebelow:1E96;horicoptic:3E9;' +
  'horizontalbar:2015;hotsprings:2668;house:2302;hsuperior:2B0;hungarumlaut:2DD;hv:195;hyphen:2D;' +
  'hypheninferior:F6E5;hyphensuperior:F6E6;hyphentwo:2010;i:69;iacute:ED;iacyrillic:44F;ibreve:12D;' +
  'icaron:1D0;icircumflex:EE;icyrillic:456;idblgrave:209;idieresis:EF;idieresisacute:1E2F;' +
  'idieresiscyrillic:4E5;idotbelow:1ECB;iebrevecyrillic:4D7;iecyrillic:435;igrave:EC;ihookabove:1EC9;' +
  'iicyrillic:438;iinvertedbreve:20B;iishortcyrillic:439;ij:133;ilde:2DC;imacron:12B;' +
  'imacroncyrillic:4E3;imageorapproximatelyequal:2253;increment:2206;infinity:221E;integral:222B;' +
  'integralbottom:2321;integralbt:2321;integralex:F8F5;integraltop:2320;integraltp:2320;' +
  'intersection:2229;invbullet:25D8;invcircle:25D9;invsmileface:263B;iocyrillic:451;iogonek:12F;' +
  'iota:3B9;iotadieresis:3CA;iotadieresistonos:390;iotatonos:3AF;isuperior:F6ED;itilde:129;' +
  'itildebelow:1E2D;iucyrillic:44E;izhitsacyrillic:475;izhitsadblgravecyrillic:477;j:6A;jcaron:1F0;' +
  'jcircumflex:135;jecyrillic:458;jsuperior:2B2;k:6B;kabashkircyrillic:4A1;kacute:1E31;kacyrillic:43A;' +
  'kadescendercyrillic:49B;kahookcyrillic:4C4;kappa:3BA;kappasymbolgreek:3F0;kastrokecyrillic:49F;' +
  'kaverticalstrokecyrillic:49D;kcaron:1E9;kcedilla:137;kcommaaccent:137;kdotbelow:1E33;' +
  'kgreenlandic:138;khacyrillic:445;kheicoptic:3E7;khook:199;kjecyrillic:45C;klinebelow:1E35;' +
  'koppacyrillic:481;ksicyrillic:46F;l:6C;lacute:13A;lambda:3BB;lambdastroke:19B;largecircle:25EF;' +
  'lbar:19A;lcaron:13E;lcedilla:13C;lcircumflexbelow:1E3D;lcommaaccent:13C;ldot:140;ldotaccent:140;' +
  'ldotbelow:1E37;ldotbelowmacron:1E39;less:3C;lessequal:2264;lessequalorgreater:22DA;' +
  'lessorequivalent:2272;lessorgreater:2276;lessoverequal:2266;lfblock:258C;lira:20A4;lj:1C9;' +
  'ljecyrillic:459;ll:F6C0;llinebelow:1E3B;logicaland:2227;logicalnot:AC;logicalnotreversed:2310;' +
  'logicalor:2228;longs:17F;lozenge:25CA;lslash:142;lsquare:2113;lsuperior:F6EE;ltshade:2591;m:6D;' +
  'macron:AF;macronlowmod:2CD;macute:1E3F;maichattawalowleftthai:F895;maichattawalowrightthai:F894;' +
  'maichattawaupperleftthai:F893;maieklowleftthai:F88C;maieklowrightthai:F88B;maiekupperleftthai:F88A;' +
  'maihanakatleftthai:F884;maitaikhuleftthai:F889;maitholowleftthai:F88F;maitholowrightthai:F88E;' +
  'maithoupperleftthai:F88D;maitrilowleftthai:F892;maitrilowrightthai:F891;maitriupperleftthai:F890;' +
  'male:2642;mars:2642;mdotaccent:1E41;mdotbelow:1E43;middot:B7;minus:2212;minuscircle:2296;' +
  'minusmod:2D7;minusplus:2213;minute:2032;msuperior:F6EF;mu:B5;mu1:B5;muchgreater:226B;muchless:226A;' +
  'mugreek:3BC;multiply:D7;musicalnote:266A;musicalnotedbl:266B;musicflatsign:266D;musicsharpsign:266F;' +
  'n:6E;nabla:2207;nacute:144;napostrophe:149;nbspace:A0;ncaron:148;ncedilla:146;ncircumflexbelow:1E4B;' +
  'ncommaaccent:146;ndotaccent:1E45;ndotbelow:1E47;newsheqelsign:20AA;nikhahitleftthai:F899;nine:39;' +
  'ninecircleinversesansserif:2792;nineinferior:2089;nineoldstyle:F739;nineroman:2178;ninesuperior:2079;' +
  'nj:1CC;njecyrillic:45A;nlegrightlong:19E;nlinebelow:1E49;nonbreakingspace:A0;notcontains:220C;' +
  'notelement:2209;notelementof:2209;notequal:2260;notgreater:226F;notgreaternorequal:2271;' +
  'notgreaternorless:2279;notidentical:2262;notless:226E;notlessnorequal:2270;notparallel:2226;' +
  'notprecedes:2280;notsubset:2284;notsucceeds:2281;notsuperset:2285;nsuperior:207F;ntilde:F1;nu:3BD;' +
  'numbersign:23;numeralsigngreek:374;numeralsignlowergreek:375;numero:2116;o:6F;oacute:F3;' +
  'obarredcyrillic:4E9;obarreddieresiscyrillic:4EB;obreve:14F;ocaron:1D2;ocircumflex:F4;' +
  'ocircumflexacute:1ED1;ocircumflexdotbelow:1ED9;ocircumflexgrave:1ED3;ocircumflexhookabove:1ED5;' +
  'ocircumflextilde:1ED7;ocyrillic:43E;odblacute:151;odblgrave:20D;odieresis:F6;odieresiscyrillic:4E7;' +
  'odotbelow:1ECD;oe:153;ogonek:2DB;ograve:F2;ohookabove:1ECF;ohorn:1A1;ohornacute:1EDB;' +
  'ohorndotbelow:1EE3;ohorngrave:1EDD;ohornhookabove:1EDF;ohorntilde:1EE1;ohungarumlaut:151;oi:1A3;' +
  'oinvertedbreve:20F;omacron:14D;omacronacute:1E53;omacrongrave:1E51;omega:3C9;omega1:3D6;' +
  'omegacyrillic:461;omegaroundcyrillic:47B;omegatitlocyrillic:47D;omegatonos:3CE;omicron:3BF;' +
  'omicrontonos:3CC;one:31;onecircleinversesansserif:278A;onedotenleader:2024;oneeighth:215B;' +
  'onefitted:F6DC;onehalf:BD;oneinferior:2081;oneoldstyle:F731;onequarter:BC;oneroman:2170;' +
  'onesuperior:B9;onethird:2153;oogonek:1EB;oogonekmacron:1ED;openbullet:25E6;option:2325;' +
  'ordfeminine:AA;ordmasculine:BA;orthogonal:221F;oslash:F8;oslashacute:1FF;ostrokeacute:1FF;' +
  'osuperior:F6F0;otcyrillic:47F;otilde:F5;otildeacute:1E4D;otildedieresis:1E4F;overline:203E;' +
  'overscore:AF;p:70;pacute:1E55;pagedown:21DF;pageup:21DE;palatalizationcyrilliccmb:484;' +
  'palochkacyrillic:4C0;paragraph:B6;parallel:2225;parenleft:28;parenleftbt:F8ED;parenleftex:F8EC;' +
  'parenleftinferior:208D;parenleftsuperior:207D;parenlefttp:F8EB;parenright:29;parenrightbt:F8F8;' +
  'parenrightex:F8F7;parenrightinferior:208E;parenrightsuperior:207E;parenrighttp:F8F6;partialdiff:2202;' +
  'pdotaccent:1E57;pecyrillic:43F;pemiddlehookcyrillic:4A7;percent:25;period:2E;periodcentered:B7;' +
  'periodinferior:F6E7;periodsuperior:F6E8;perpendicular:22A5;perthousand:2030;peseta:20A7;phi:3C6;' +
  'phi1:3D5;phisymbolgreek:3D5;phook:1A5;pi:3C0;pisymbolgreek:3D6;planckover2pi:210F;' +
  'planckover2pi1:210F;plus:2B;pluscircle:2295;plusminus:B1;plusmod:2D6;plussuperior:207A;' +
  'pointingindexdownwhite:261F;pointingindexleftwhite:261C;pointingindexrightwhite:261E;' +
  'pointingindexupwhite:261D;precedes:227A;prescription:211E;primemod:2B9;primereversed:2035;' +
  'product:220F;projective:2305;propellor:2318;propersubset:2282;propersuperset:2283;proportion:2237;' +
  'proportional:221D;psi:3C8;psicyrillic:471;psilipneumatacyrilliccmb:486;q:71;quarternote:2669;' +
  'question:3F;questiondown:BF;questiondownsmall:F7BF;questiongreek:37E;questionsmall:F73F;quotedbl:22;' +
  'quotedblbase:201E;quotedblleft:201C;quotedblright:201D;quoteleft:2018;quoteleftreversed:201B;' +
  'quotereversed:201B;quoteright:2019;quoterightn:149;quotesinglbase:201A;quotesingle:27;r:72;' +
  'racute:155;radical:221A;radicalex:F8E5;ratio:2236;rcaron:159;rcedilla:157;rcommaaccent:157;' +
  'rdblgrave:211;rdotaccent:1E59;rdotbelow:1E5B;rdotbelowmacron:1E5D;referencemark:203B;' +
  'reflexsubset:2286;reflexsuperset:2287;registered:AE;registersans:F8E8;registerserif:F6DA;' +
  'reversedtilde:223D;revlogicalnot:2310;rho:3C1;rhookturnedsuperior:2B5;rhosymbolgreek:3F1;' +
  'rhotichookmod:2DE;rightangle:221F;righttriangle:22BF;ring:2DA;ringhalfleft:2BF;' +
  'ringhalfleftcentered:2D3;ringhalfright:2BE;ringhalfrightcentered:2D2;rinvertedbreve:213;' +
  'rlinebelow:1E5F;rsuperior:F6F1;rtblock:2590;rturnedsuperior:2B4;rupiah:F6DD;s:73;sacute:15B;' +
  'sacutedotaccent:1E65;saraiileftthai:F886;saraileftthai:F885;saraueeleftthai:F888;saraueleftthai:F887;' +
  'scaron:161;scarondotaccent:1E67;scedilla:15F;schwacyrillic:4D9;schwadieresiscyrillic:4DB;' +
  'scircumflex:15D;scommaaccent:219;sdotaccent:1E61;sdotbelow:1E63;sdotbelowdotaccent:1E69;second:2033;' +
  'secondtonechinese:2CA;section:A7;semicolon:3B;seven:37;sevencircleinversesansserif:2790;' +
  'seveneighths:215E;seveninferior:2087;sevenoldstyle:F737;sevenroman:2176;sevensuperior:2077;' +
  'sfthyphen:AD;shacyrillic:448;shade:2592;shadedark:2593;shadelight:2591;shademedium:2592;' +
  'shchacyrillic:449;sheicoptic:3E3;sheqel:20AA;sheqelhebrew:20AA;shhacyrillic:4BB;shimacoptic:3ED;' +
  'sigma:3C3;sigma1:3C2;sigmafinal:3C2;sigmalunatesymbolgreek:3F2;similar:223C;six:36;' +
  'sixcircleinversesansserif:278F;sixinferior:2086;sixoldstyle:F736;sixroman:2175;sixsuperior:2076;' +
  'slash:2F;slong:17F;slongdotaccent:1E9B;smileface:263A;softhyphen:AD;softsigncyrillic:44C;space:20;' +
  'spacehackarabic:20;spade:2660;spadesuitblack:2660;spadesuitwhite:2664;' +
  'squarediagonalcrosshatchfill:25A9;squarehorizontalfill:25A4;squareorthogonalcrosshatchfill:25A6;' +
  'squareupperlefttolowerrightfill:25A7;squareupperrighttolowerleftfill:25A8;squareverticalfill:25A5;' +
  'squarewhitewithsmallblack:25A3;ssuperior:F6F2;sterling:A3;subset:2282;subsetnotequal:228A;' +
  'subsetorequal:2286;succeeds:227B;suchthat:220B;summation:2211;sun:263C;superset:2283;' +
  'supersetnotequal:228B;supersetorequal:2287;t:74;tackdown:22A4;tackleft:22A3;tau:3C4;tbar:167;' +
  'tcaron:165;tcedilla:163;tcircumflexbelow:1E71;tcommaaccent:163;tdieresis:1E97;tdotaccent:1E6B;' +
  'tdotbelow:1E6D;tecyrillic:442;tedescendercyrillic:4AD;telephone:2121;telephoneblack:260E;' +
  'tenroman:2179;tetsecyrillic:4B5;thanthakhatlowleftthai:F898;thanthakhatlowrightthai:F897;' +
  'thanthakhatupperleftthai:F896;thereexists:2203;therefore:2234;theta:3B8;theta1:3D1;' +
  'thetasymbolgreek:3D1;thook:1AD;thorn:FE;thousandcyrillic:482;three:33;' +
  'threecircleinversesansserif:278C;threeeighths:215C;threeinferior:2083;threeoldstyle:F733;' +
  'threequarters:BE;threequartersemdash:F6DE;threeroman:2172;threesuperior:B3;tilde:2DC;' +
  'tildeoperator:223C;timescircle:2297;titlocyrilliccmb:483;tlinebelow:1E6F;tonebarextrahighmod:2E5;' +
  'tonebarextralowmod:2E9;tonebarhighmod:2E6;tonebarlowmod:2E8;tonebarmidmod:2E7;tonefive:1BD;' +
  'tonesix:185;tonetwo:1A8;tonos:384;tpalatalhook:1AB;trademark:2122;trademarksans:F8EA;' +
  'trademarkserif:F6DB;triagdn:25BC;triaglf:25C4;triagrt:25BA;triagup:25B2;tsecyrillic:446;' +
  'tshecyrillic:45B;tsuperior:F6F3;twelveroman:217B;two:32;twocircleinversesansserif:278B;' +
  'twodotenleader:2025;twodotleader:2025;twoinferior:2082;twooldstyle:F732;tworoman:2171;twostroke:1BB;' +
  'twosuperior:B2;twothirds:2154;u:75;uacute:FA;ubreve:16D;ucaron:1D4;ucircumflex:FB;' +
  'ucircumflexbelow:1E77;ucyrillic:443;udblacute:171;udblgrave:215;udieresis:FC;udieresisacute:1D8;' +
  'udieresisbelow:1E73;udieresiscaron:1DA;udieresiscyrillic:4F1;udieresisgrave:1DC;udieresismacron:1D6;' +
  'udotbelow:1EE5;ugrave:F9;uhookabove:1EE7;uhorn:1B0;uhornacute:1EE9;uhorndotbelow:1EF1;' +
  'uhorngrave:1EEB;uhornhookabove:1EED;uhorntilde:1EEF;uhungarumlaut:171;uhungarumlautcyrillic:4F3;' +
  'uinvertedbreve:217;ukcyrillic:479;umacron:16B;umacroncyrillic:4EF;umacrondieresis:1E7B;underscore:5F;' +
  'underscoredbl:2017;union:222A;universal:2200;uogonek:173;upblock:2580;upsilon:3C5;' +
  'upsilondieresis:3CB;upsilondieresistonos:3B0;upsilontonos:3CD;uptackmod:2D4;uring:16F;' +
  'ushortcyrillic:45E;ustraightcyrillic:4AF;ustraightstrokecyrillic:4B1;utilde:169;utildeacute:1E79;' +
  'utildebelow:1E75;v:76;vdotbelow:1E7F;vecyrillic:432;venus:2640;verticalbar:7C;verticallinelowmod:2CC;' +
  'verticallinemod:2C8;vtilde:1E7D;w:77;wacute:1E83;wcircumflex:175;wdieresis:1E85;wdotaccent:1E87;' +
  'wdotbelow:1E89;weierstrass:2118;wgrave:1E81;whitebullet:25E6;whitecircle:25CB;' +
  'whitecircleinverse:25D9;whitediamond:25C7;whitediamondcontainingblacksmalldiamond:25C8;' +
  'whitedownpointingsmalltriangle:25BF;whitedownpointingtriangle:25BD;' +
  'whiteleftpointingsmalltriangle:25C3;whiteleftpointingtriangle:25C1;' +
  'whiterightpointingsmalltriangle:25B9;whiterightpointingtriangle:25B7;whitesmallsquare:25AB;' +
  'whitesmilingface:263A;whitesquare:25A1;whitestar:2606;whitetelephone:260F;' +
  'whiteuppointingsmalltriangle:25B5;whiteuppointingtriangle:25B3;won:20A9;wring:1E98;wsuperior:2B7;' +
  'wynn:1BF;x:78;xdieresis:1E8D;xdotaccent:1E8B;xi:3BE;xsuperior:2E3;y:79;yacute:FD;yatcyrillic:463;' +
  'ycircumflex:177;ydieresis:FF;ydotaccent:1E8F;ydotbelow:1EF5;yen:A5;yericyrillic:44B;' +
  'yerudieresiscyrillic:4F9;ygrave:1EF3;yhook:1B4;yhookabove:1EF7;yicyrillic:457;yinyang:262F;' +
  'yotgreek:3F3;ypogegrammeni:37A;yr:1A6;yring:1E99;ysuperior:2B8;ytilde:1EF9;yusbigcyrillic:46B;' +
  'yusbigiotifiedcyrillic:46D;yuslittlecyrillic:467;yuslittleiotifiedcyrillic:469;z:7A;zacute:17A;' +
  'zcaron:17E;zcircumflex:1E91;zdot:17C;zdotaccent:17C;zdotbelow:1E93;zecyrillic:437;' +
  'zedescendercyrillic:499;zedieresiscyrillic:4DF;zero:30;zeroinferior:2080;zerooldstyle:F730;' +
  'zerosuperior:2070;zerowidthnonjoiner:200C;zerowidthspace:200B;zeta:3B6;zhebrevecyrillic:4C2;' +
  'zhecyrillic:436;zhedescendercyrillic:497;zhedieresiscyrillic:4DD;zlinebelow:1E95;zstroke:1B6;a1:2701;' +
  'a2:2702;a202:2703;a3:2704;a4:260E;a5:2706;a119:2707;a118:2708;a117:2709;a11:261B;a12:261E;a13:270C;' +
  'a14:270D;a15:270E;a16:270F;a105:2710;a17:2711;a18:2712;a19:2713;a20:2714;a21:2715;a22:2716;a23:2717;' +
  'a24:2718;a25:2719;a26:271A;a27:271B;a28:271C;a6:271D;a7:271E;a8:271F;a9:2720;a10:2721;a29:2722;' +
  'a30:2723;a31:2724;a32:2725;a33:2726;a34:2727;a35:2605;a36:2729;a37:272A;a38:272B;a39:272C;a40:272D;' +
  'a41:272E;a42:272F;a43:2730;a44:2731;a45:2732;a46:2733;a47:2734;a48:2735;a49:2736;a50:2737;a51:2738;' +
  'a52:2739;a53:273A;a54:273B;a55:273C;a56:273D;a57:273E;a58:273F;a59:2740;a60:2741;a61:2742;a62:2743;' +
  'a63:2744;a64:2745;a65:2746;a66:2747;a67:2748;a68:2749;a69:274A;a70:274B;a71:25CF;a72:274D;a73:25A0;' +
  'a74:274F;a203:2750;a75:2751;a204:2752;a76:25B2;a77:25BC;a78:25C6;a79:2756;a81:25D7;a82:2758;a83:2759;' +
  'a84:275A;a97:275B;a98:275C;a99:275D;a100:275E;a101:2761;a102:2762;a103:2763;a104:2764;a106:2765;' +
  'a107:2766;a108:2767;a112:2663;a111:2666;a110:2665;a109:2660;a120:2460;a121:2461;a122:2462;a123:2463;' +
  'a124:2464;a125:2465;a126:2466;a127:2467;a128:2468;a129:2469;a130:2776;a131:2777;a132:2778;a133:2779;' +
  'a134:277A;a135:277B;a136:277C;a137:277D;a138:277E;a139:277F;a140:2780;a141:2781;a142:2782;a143:2783;' +
  'a144:2784;a145:2785;a146:2786;a147:2787;a148:2788;a149:2789;a150:278A;a151:278B;a152:278C;a153:278D;' +
  'a154:278E;a155:278F;a156:2790;a157:2791;a158:2792;a159:2793;a160:2794;a161:2192;a163:2194;a164:2195;' +
  'a196:2798;a165:2799;a192:279A;a166:279B;a167:279C;a168:279D;a169:279E;a170:279F;a171:27A0;a172:27A1;' +
  'a173:27A2;a162:27A3;a174:27A4;a175:27A5;a176:27A6;a177:27A7;a178:27A8;a179:27A9;a193:27AA;a180:27AB;' +
  'a199:27AC;a181:27AD;a200:27AE;a182:27AF;a201:27B1;a183:27B2;a184:27B3;a197:27B4;a185:27B5;a194:27B6;' +
  'a198:27B7;a186:27B8;a195:27B9;a187:27BA;a188:27BB;a189:27BC;a190:27BD;a191:27BE;a89:2768;a90:2769;' +
  'a93:276A;a94:276B;a91:276C;a92:276D;a205:276E;a85:276F;a206:2770;a86:2771;a87:2772;a88:2773;a95:2774;' +
  'a96:2775;.notdef:0';

let forward: Map<string, string> | undefined;
let reverse: Map<string, string> | undefined;

function forwardMap(): Map<string, string> {
  if (forward) return forward;
  const map = new Map<string, string>();
  for (const entry of AGL_DATA.split(';')) {
    const colon = entry.indexOf(':');
    map.set(entry.slice(0, colon), String.fromCodePoint(parseInt(entry.slice(colon + 1), 16)));
  }
  forward = map;
  return map;
}

function reverseMap(): Map<string, string> {
  if (reverse) return reverse;
  const fwd = forwardMap();
  const map = new Map<string, string>();
  const add = (name: string, text: string): void => {
    if (text.length === 0 || text.codePointAt(0) === undefined) return;
    if (String.fromCodePoint(text.codePointAt(0) as number) !== text) return; // several code points
    if (!map.has(text)) map.set(text, name);
  };
  // Names used by the predefined encodings win over other AGL synonyms (periodcentered
  // over middot, mu over mu1, space over spacehackarabic) so that the name found here
  // is the one a simple font's encoding is likely to contain.
  for (const table of [
    STANDARD_ENCODING,
    WIN_ANSI_ENCODING,
    MAC_ROMAN_ENCODING,
    PDF_DOC_ENCODING,
    SYMBOL_ENCODING,
    ZAPF_DINGBATS_ENCODING,
  ]) {
    for (const name of table) {
      if (name === undefined) continue;
      const text = fwd.get(name);
      if (text !== undefined) add(name, text);
    }
  }
  for (const [name, text] of fwd) add(name, text);
  reverse = map;
  return map;
}

function isScalar(cp: number): boolean {
  return cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
}

const UNI_RE = /^uni((?:[0-9A-Fa-f]{4})+)$/;
const U_RE = /^u([0-9A-Fa-f]{4,6})$/;

function componentToUnicode(name: string): string | undefined {
  const direct = forwardMap().get(name);
  if (direct !== undefined) return direct;
  const uni = UNI_RE.exec(name);
  if (uni) {
    const hex = uni[1];
    let out = '';
    for (let i = 0; i < hex.length; i += 4) {
      const cp = parseInt(hex.slice(i, i + 4), 16);
      if (!isScalar(cp)) return undefined;
      out += String.fromCodePoint(cp);
    }
    return out;
  }
  const u = U_RE.exec(name);
  if (u) {
    const cp = parseInt(u[1], 16);
    return isScalar(cp) ? String.fromCodePoint(cp) : undefined;
  }
  return undefined;
}

/**
 * Maps a glyph name to the text it represents, or undefined when the name
 * carries no Unicode meaning. The result may be several code points
 * (`uni00660069`, `f_i`).
 */
export function glyphNameToUnicode(name: string): string | undefined {
  if (name.length === 0) return undefined;
  const period = name.indexOf('.');
  if (period === 0) return undefined; // .notdef, .null
  const base = period > 0 ? name.slice(0, period) : name;
  if (base.length === 0) return undefined;
  if (base.indexOf('_') < 0) return componentToUnicode(base);
  let out = '';
  for (const part of base.split('_')) {
    const text = componentToUnicode(part);
    if (text === undefined) return undefined;
    out += text;
  }
  return out;
}

/**
 * Reverse of the AGL table for a single code point: the glyph name a simple
 * font is expected to use for `ch`. Names used by the Annex D encodings take
 * precedence, then the first AGL name in list order. Undefined for input that
 * is not exactly one code point or has no AGL name.
 */
export function unicodeToGlyphName(ch: string): string | undefined {
  if (ch.length === 0) return undefined;
  const cp = ch.codePointAt(0);
  if (cp === undefined || String.fromCodePoint(cp) !== ch) return undefined;
  return reverseMap().get(ch);
}
