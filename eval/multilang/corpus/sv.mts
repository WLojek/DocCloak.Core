/**
 * T124 gold corpus: Swedish (Sverige).
 * Authored as segments; offsets computed by doc(). See ../schema.mts.
 * Personnummer spans allow alt DATE since the prefix encodes a birthdate.
 */
import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  // Introduktionsmejl. Traps: "wienerbröd", "en liten lund av björkar".
  doc('sv-01', 'sv', 'email', [
    'Hej teamet, vi välkomnar ', ['Erik Lindqvist', 'PERSON'],
    ' som börjar den ', ['4 mars 2026', 'DATE'],
    '. Hans e-post är ', ['erik.lindqvist@exempelbolag.se', 'EMAIL'],
    ' och mobilnumret är ', ['070-123 45 67', 'PHONE'],
    '. Han kommer att sitta på kontoret hos ', ['Nordströms Datakonsult AB', 'COMPANY'],
    ', ', ['Storgatan 14', 'ADDRESS'], ', ', ['211 34', 'ADDRESS'], ' ',
    ['Malmö', 'ADDRESS'],
    '. Ta gärna med wienerbröd på fredag; vi ses vid en liten lund av björkar bakom huset om vädret håller.',
  ]),

  // Chattmeddelande till en AI-assistent. Trap: "falukorv-reklam".
  doc('sv-02', 'sv', 'chat', [
    'Hej, kan du hjälpa mig formulera ett svar? ', ['Johan Bergström', 'PERSON'],
    ' från ', ['Fjällvind Logistik AB', 'COMPANY'],
    ' ringde och vill att jag återkommer på ', ['+46 70 234 56 78', 'PHONE'],
    ' eller mejlar ', ['johan.bergstrom@fjallvind.se', 'EMAIL'],
    '. Han vill ha besked senast den ', ['15 oktober 2026', 'DATE'],
    ', men priset på ', ['48 900 kr', 'CURRENCY'],
    ' känns högt. Deras testserver ligger på ', ['198.51.100.23', 'IP_ADDRESS'],
    ' om det spelar någon roll. Skriv vänligt, jag vill inte trampa någon på tårna, och det får inte låta som en falukorv-reklam.',
  ]),

  // Personalakt. Traps: "en smal stig", "vill bo kvar".
  doc('sv-03', 'sv', 'hr', [
    'KONFIDENTIELLT, personalakt. Medarbetare: ', ['Annika Sjöberg', 'PERSON'],
    ', född den ', ['12 mars 1985', 'DATE'],
    ', personnummer ', ['850312-4571', 'SSN', ['DATE']],
    '. Adress: ', ['Björkvägen 47', 'ADDRESS'], ', ', ['582 46', 'ADDRESS'], ' ',
    ['Linköping', 'ADDRESS'],
    '. Telefon: ', ['013-555 01 42', 'PHONE'],
    ', privat e-post ', ['annika.sjoberg@mailexempel.se', 'EMAIL'], '. ',
    ['Sjöberg', 'PERSON'], ' anställdes den ', ['1 februari 2018', 'DATE'],
    ' och har en månadslön på ', ['45 300 kr', 'CURRENCY'],
    '. Anmärkning: hon tar gärna en promenad längs en smal stig vid lunch, och hon vill bo kvar i stan.',
  ]),

  // Intagningsjournal. Trap: "stark som en björn".
  doc('sv-04', 'sv', 'medical', [
    'Intagningsjournal. Patient: ', ['Gunnar Wallin', 'PERSON'],
    ', född ', ['1954-07-22', 'DATE'],
    '. Inlagd den ', ['4 augusti 2026', 'DATE'],
    ' för bröstsmärtor. Anhörig: dottern ', ['Karin Wallin', 'PERSON'],
    ', telefon ', ['+46 31 555 01 42', 'PHONE'],
    '. Försäkring via ', ['Skandinaviska Hälsokassan AB', 'COMPANY'],
    '. Bostadsadress: ', ['Kvarnbygatan 3', 'ADDRESS'], ', ', ['431 34', 'ADDRESS'],
    ' ', ['Mölndal', 'ADDRESS'],
    '. Patienten säger att han till vardags är stark som en björn och undrar varför han plötsligt blir andfådd.',
  ]),

  // Faktura. Trap: "ett vad vid ån" (vadstaelle).
  doc('sv-05', 'sv', 'invoice', [
    'FAKTURA nr 2026-0311, utställd den ', ['10 april 2026', 'DATE'],
    '. Avsändare: ', ['Verkstadsbolaget Snickeri AB', 'COMPANY'], ', ',
    ['Industrigatan 8', 'ADDRESS'], ', ', ['702 25', 'ADDRESS'], ' ',
    ['Örebro', 'ADDRESS'],
    '. Mottagare: ', ['Cecilia Åkerman', 'PERSON'],
    '. Att betala: ', ['12 750,00 kr', 'CURRENCY'],
    '. Vänligen betala inom 30 dagar till IBAN ', ['SE45 5000 0000 0583 9825 7466', 'IBAN'],
    '. Frågor: ', ['ekonomi@verkstadsbolaget.se', 'EMAIL'],
    ' eller ', ['019-555 08 20', 'PHONE'],
    '. Leveransen gick bra trots att vägen korsar ett vad vid ån.',
  ]),

  // Förlikningsavtal. Trap: "sitta med svarte petter".
  doc('sv-06', 'sv', 'legal', [
    'FÖRLIKNINGSAVTAL daterat den ', ['30 juni 2026', 'DATE'], ' mellan ',
    ['Margareta Holmgren', 'PERSON'], ' (käranden) och ',
    ['Nordanvind Energi AB', 'COMPANY'],
    ' (svaranden). Käranden, bosatt på ', ['Trädgårdsgatan 21', 'ADDRESS'], ', ',
    ['903 26', 'ADDRESS'], ' ', ['Umeå', 'ADDRESS'],
    ', erhåller ', ['950 000 kr', 'CURRENCY'],
    ' som full och slutlig reglering. Svarandens ombud, advokat ',
    ['Pär Nystedt', 'PERSON'], ', nås på ', ['+46 90 555 01 88', 'PHONE'],
    '. Ingen part avser att väcka ny talan; var och en står sin egen kostnad, och ingen vill sitta med svarte petter.',
  ]),

  // Vardagligt meddelande. Traps: "wienerkorv", "falukorv".
  doc('sv-07', 'sv', 'casual', [
    'Snabbt innan jag glömmer: jag bokade stugan till den ', ['22 augusti 2026', 'DATE'],
    ' och betalade handpenningen med kortet ', ['4571-8834-2210-9067', 'CREDIT_CARD'],
    ', giltigt till 09/28. Det blir ', ['3 100 kr', 'CURRENCY'],
    ' per person. ', ['Nadja', 'PERSON'], ' kör, sms:a henne på ',
    ['073-987 65 43', 'PHONE'], '. Min kusin ', ['Ludvig Hagström', 'PERSON'],
    ' hänger kanske på, han jobbar på ', ['Torvfält Media AB', 'COMPANY'],
    '. Han tar med wienerkorv och en hel låda falukorv, så ingen svälter.',
  ]),

  // Ansökningsblankett. Trap: "en stig bakom skolan".
  doc('sv-08', 'sv', 'form', [
    'Ansökningsblankett, kontoöppning.\nFullständigt namn: ', ['Fredrika Östlund', 'PERSON'],
    '\nFödelsedatum: ', ['1990-11-02', 'DATE'],
    '\nPersonnummer: ', ['901102-2384', 'SSN', ['DATE']],
    '\nGatuadress: ', ['Cederstigen 90', 'ADDRESS'],
    '\nPostnummer: ', ['118 25', 'ADDRESS'],
    '\nOrt: ', ['Stockholm', 'ADDRESS'],
    '\nTelefon: ', ['08-555 01 99', 'PHONE'],
    '\nE-post: ', ['f.ostlund@exempelpost.se', 'EMAIL'],
    '\nArbetsgivare: ', ['Concordia Biolab AB', 'COMPANY'],
    '\nMånadsinkomst: ', ['34 500 kr', 'CURRENCY'],
    '\nÖvrigt: ring helst inte på måndagar, då hämtar jag barnen vid en stig bakom skolan.',
  ]),
];
