/**
 * T124 gold corpus: Czech (cs). 8 docs, genres email/chat/hr/medical/invoice/legal/casual/form.
 * All identities fictional; rodna cisla structurally correct (female month +50),
 * checksums not guaranteed. Plain-text ambiguity traps (not gold): month names
 * mid-sentence (v kvetnu, v dubnu, v listopadu, v cervnu), "kovar" (the blacksmith),
 * city adjectives in food names (prazska sunka, vidensky rizek, moravsky kolac).
 */

import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  doc('cs-01', 'cs', 'email', [
    'Dobrý den, navazuji na jednání s panem ', ['Jiřím Dvořákem', 'PERSON'],
    ' ze společnosti ', ['Moravia Trans s.r.o.', 'COMPANY'],
    '. Podklady ke smlouvě prosím zašlete na ', ['jiri.dvorak@moraviatrans.cz', 'EMAIL'],
    ' nejpozději do ', ['20. března 2026', 'DATE'],
    '. V případě dotazů volejte na číslo ', ['+420 601 123 456', 'PHONE'],
    '. Fakturovaná částka činí ', ['48 500 Kč', 'CURRENCY'],
    ' a je splatná na účet ', ['CZ65 0800 0000 1920 0014 5399', 'IBAN'],
    '. V květnu plánujeme navazující školení pro celý tým. S pozdravem ',
    ['Lenka Svobodová', 'PERSON'], '.',
  ]),

  doc('cs-02', 'cs', 'chat', [
    'Ahoj, potřebuju poradit se stížností. Objednal jsem si notebook od prodejce jménem ',
    ['Petr Novotný', 'PERSON'], ', který uvedl telefon ', ['777 234 567', 'PHONE'],
    ' a e-mail ', ['petr.novotny78@seznam.cz', 'EMAIL'],
    '. Zaplatil jsem ', ['6 890 Kč', 'CURRENCY'], ' kartou ',
    ['4556 7375 8689 9855', 'CREDIT_CARD'], ' dne ', ['5. 2. 2026', 'DATE'],
    '. Balík měl dorazit na adresu ', ['Dlouhá 12', 'ADDRESS'], ', ',
    ['110 00', 'ADDRESS'], ' ', ['Praha 1', 'ADDRESS'],
    '. Podle e-shopu se prodejce naposledy přihlásil z adresy ', ['185.63.98.14', 'IP_ADDRESS'],
    '. Sliboval doručení ještě v dubnu a pak přestal komunikovat. Můžeš mi napsat text reklamace?',
  ]),

  doc('cs-03', 'cs', 'hr', [
    'Personální záznam. Zaměstnankyně: ', ['Hana Procházková', 'PERSON'],
    ', narozena ', ['12. 3. 1985', 'DATE'], ', rodné číslo ',
    ['855312/1234', 'SSN', ['DATE']], ', nastoupila do společnosti ',
    ['Bohemia Soft a.s.', 'COMPANY'], ' dne ', ['1. 9. 2024', 'DATE'],
    '. Trvalé bydliště: ', ['Krátká 7', 'ADDRESS'], ', ', ['602 00', 'ADDRESS'],
    ' ', ['Brno', 'ADDRESS'], '. Hrubá mzda: ', ['52 000 Kč', 'CURRENCY'],
    '. Přímý nadřízený: pan ', ['Marek Veselý', 'PERSON'], ', linka ',
    ['+420 543 210 876', 'PHONE'],
    '. Roční hodnocení proběhne v listopadu, podklady připraví oddělení mezd.',
  ]),

  doc('cs-04', 'cs', 'medical', [
    'Propouštěcí zpráva. Pacient: ', ['Václav Černý', 'PERSON'],
    ', nar. ', ['7. 7. 1958', 'DATE'], ', r. č. ', ['580707/0891', 'SSN', ['DATE']],
    ', přijat dne ', ['21. 1. 2026', 'DATE'],
    ' pro bolesti na hrudi. Ošetřující lékařka: MUDr. ', ['Eva Malá', 'PERSON'],
    '. Kontakt na rodinu: dcera, tel. ', ['+420 605 998 321', 'PHONE'],
    '. Kontrola v kardiologické ambulanci na adrese ', ['Zahradní 22', 'ADDRESS'],
    ' v ', ['Olomouci', 'ADDRESS'],
    ' za čtrnáct dní. Doporučena lehká strava, žádný vídeňský řízek ani pražská šunka, omezit sůl.',
  ]),

  doc('cs-05', 'cs', 'invoice', [
    'Faktura č. 2026-0117. Dodavatel: ', ['Nábytek Horák s.r.o.', 'COMPANY'],
    ', se sídlem ', ['Tovární 5', 'ADDRESS'], ', ', ['779 00', 'ADDRESS'], ' ',
    ['Olomouc', 'ADDRESS'], '. Odběratel: ', ['Michal Král', 'PERSON'],
    ', e-mail ', ['michal.kral@email.cz', 'EMAIL'],
    '. Datum vystavení: ', ['28. 2. 2026', 'DATE'],
    '. Celkem k úhradě: ', ['12 340,50 Kč', 'CURRENCY'],
    '. Platbu poukažte na účet ', ['CZ42 0100 0000 1955 0203 7981', 'IBAN'],
    ' se splatností 14 dnů. Zboží: dubový stůl a čtyři židle, dodání koncem března.',
  ]),

  doc('cs-06', 'cs', 'legal', [
    'Smlouva o nájmu bytu uzavřená dne ', ['5. ledna 2026', 'DATE'],
    ' mezi paní ', ['Alenou Pokornou', 'PERSON'], ', bytem ',
    ['Vinohradská 44', 'ADDRESS'], ', ', ['130 00', 'ADDRESS'], ' ',
    ['Praha 3', 'ADDRESS'], ', dále jen pronajímatelka, a panem ',
    ['Tomášem Musilem', 'PERSON'], ', r. č. ', ['910422/5678', 'SSN', ['DATE']],
    ', dále jen nájemce. Nájemné ve výši ', ['16 800 Kč', 'CURRENCY'],
    ' měsíčně je splatné na účet ', ['CZ12 5500 0000 0034 5678 9012', 'IBAN'],
    ' vždy do 10. dne měsíce. Kontakt na pronajímatelku: ',
    ['alena.pokorna@centrum.cz', 'EMAIL'], ', tel. ', ['731 456 208', 'PHONE'],
    '. Kauce bude vrácena v červnu po skončení nájmu a vyúčtování drobných oprav.',
  ]),

  doc('cs-07', 'cs', 'casual', [
    'Představ si, koho jsem včera potkala na náměstí, ', ['Terezu Novákovou', 'PERSON'],
    ' ze střední! Dala mi své nové číslo ', ['+420 722 583 946', 'PHONE'],
    ' a prý teď dělá grafičku ve firmě ', ['Studio Čárka', 'COMPANY'],
    '. Bydlí kousek od parku v ulici ', ['Květinová 17', 'ADDRESS'],
    ' v ', ['Plzni', 'ADDRESS'], ', stěhovali se ', ['10. listopadu 2025', 'DATE'],
    '. Za kávu a moravský koláč jsem dala ', ['185 Kč', 'CURRENCY'],
    '. Číšník vypadal jako starý kovář, samé svaly a mohutné ruce. Objednaly jsme si ještě ruské vejce.',
  ]),

  doc('cs-08', 'cs', 'form', [
    'Registrační formulář - zákaznický portál.\nJméno a příjmení: ',
    ['Radek Beneš', 'PERSON'], '\nDatum narození: ', ['02.11.1990', 'DATE'],
    '\nRodné číslo: ', ['901102/4321', 'SSN', ['DATE']],
    '\nAdresa: ', ['Polní 44', 'ADDRESS'], ', ', ['500 03', 'ADDRESS'], ' ',
    ['Hradec Králové', 'ADDRESS'], '\nTelefon: ', ['495 218 664', 'PHONE'],
    '\nE-mail: ', ['radek.benes90@gmail.com', 'EMAIL'],
    '\nČíslo platební karty: ', ['5375 8123 4402 9917', 'CREDIT_CARD'],
    '\nIP adresa registrace: ', ['89.176.22.203', 'IP_ADDRESS'],
    '\nSouhlas s newsletterem: ANO\nPoznámka: ozvěte se prosím až po Velikonocích.',
  ]),
];
