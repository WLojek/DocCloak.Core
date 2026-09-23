/**
 * T124 gold corpus: Norwegian Bokmål (Norge).
 * Authored as segments; offsets computed by doc(). See ../schema.mts.
 * Fødselsnummer spans allow alt DATE since the prefix encodes a birthdate.
 */
import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  // Onboarding-e-post. Traps: "wienerbrød", "et lite berg av paller".
  doc('no-01', 'no', 'email', [
    'Hei team, vi ønsker ', ['Håkon Solbakken', 'PERSON'],
    ' velkommen fra ', ['4. mars 2026', 'DATE'],
    '. E-posten hans er ', ['hakon.solbakken@eksempelfirma.no', 'EMAIL'],
    ' og mobilen er ', ['912 34 567', 'PHONE'],
    '. Han skal sitte på kontoret til ', ['Nordlys Datakonsult AS', 'COMPANY'],
    ', ', ['Storgata 14', 'ADDRESS'], ', ', ['7010', 'ADDRESS'], ' ',
    ['Trondheim', 'ADDRESS'],
    '. Ta gjerne med wienerbrød på fredag; vi møtes ved et lite berg av paller bak bygget hvis været holder.',
  ]),

  // Chatmelding limt inn til en AI-assistent. Trap: "frankfurterpølser".
  doc('no-02', 'no', 'chat', [
    'Hei, kan du hjelpe meg å formulere et svar? ', ['Sindre Myklebust', 'PERSON'],
    ' fra ', ['Fjellvind Logistikk AS', 'COMPANY'],
    ' ringte og vil at jeg ringer tilbake på ', ['+47 402 34 567', 'PHONE'],
    ' eller sender e-post til ', ['sindre.myklebust@fjellvind.no', 'EMAIL'],
    '. Han vil ha svar innen ', ['15. oktober 2026', 'DATE'],
    ', men prisen på ', ['48 900 kr', 'CURRENCY'],
    ' virker høy. Testserveren deres ligger på ', ['198.51.100.77', 'IP_ADDRESS'],
    ' hvis det er relevant. Skriv vennlig; jeg vil ikke tråkke noen på tærne, og det skal ikke høres ut som reklame for frankfurterpølser.',
  ]),

  // Personalmappe. Traps: "en smal sti", "sterk som en bjørn".
  doc('no-03', 'no', 'hr', [
    'KONFIDENSIELT, personalmappe. Ansatt: ', ['Ingrid Fossum', 'PERSON'],
    ', født ', ['12.05.1985', 'DATE'],
    ', fødselsnummer ', ['12058512345', 'SSN', ['DATE']],
    '. Adresse: ', ['Bjørkeveien 47', 'ADDRESS'], ', ', ['5063', 'ADDRESS'], ' ',
    ['Bergen', 'ADDRESS'],
    '. Telefon: ', ['55 55 01 42', 'PHONE'],
    ', privat e-post ', ['ingrid.fossum@posteksempel.no', 'EMAIL'], '. ',
    ['Fossum', 'PERSON'], ' ble ansatt ', ['1. februar 2018', 'DATE'],
    ' og har en månedslønn på ', ['52 300 kr', 'CURRENCY'],
    '. Merknad: hun tar gjerne en tur langs en smal sti i lunsjen, og hun er sterk som en bjørn i budsjettforhandlinger.',
  ]),

  // Innleggelsesnotat. Traps: "wienerpølse", "en god dag er en dag med tur".
  doc('no-04', 'no', 'medical', [
    'Innleggelsesnotat. Pasient: ', ['Gunnar Vestby', 'PERSON'],
    ', født ', ['22.07.1954', 'DATE'],
    '. Innlagt ', ['4. august 2026', 'DATE'],
    ' med brystsmerter. Pårørende: datteren ', ['Kari Vestby', 'PERSON'],
    ', telefon ', ['+47 22 55 01 42', 'PHONE'],
    '. Forsikret gjennom ', ['Skandinavisk Helsekasse AS', 'COMPANY'],
    '. Bostedsadresse: ', ['Kvernveien 3', 'ADDRESS'], ', ', ['0563', 'ADDRESS'],
    ' ', ['Oslo', 'ADDRESS'],
    '. Pasienten spør om en wienerpølse i ny og ne er greit; ellers vil han ikke endre noe, for en god dag er en dag med tur.',
  ]),

  // Faktura. Traps: "et vadested", "en stor stein".
  doc('no-05', 'no', 'invoice', [
    'FAKTURA nr. 2026-0311, utstedt ', ['10. april 2026', 'DATE'],
    '. Avsender: ', ['Verkstedet Snekkeri AS', 'COMPANY'], ', ',
    ['Industrigata 8', 'ADDRESS'], ', ', ['4014', 'ADDRESS'], ' ',
    ['Stavanger', 'ADDRESS'],
    '. Mottaker: ', ['Cecilie Aakre', 'PERSON'],
    '. Å betale: ', ['12 750,00 kr', 'CURRENCY'],
    '. Vennligst betal innen 30 dager til IBAN ', ['NO93 8601 1117 947', 'IBAN'],
    '. Spørsmål: ', ['okonomi@verkstedet-snekkeri.no', 'EMAIL'],
    ' eller ', ['51 55 08 20', 'PHONE'],
    '. Leveransen gikk fint selv om veien krysser et vadested ved elva, og sjåføren måtte flytte en stor stein.',
  ]),

  // Forliksavtale. Trap: "sitte igjen med svarteper".
  doc('no-06', 'no', 'legal', [
    'FORLIKSAVTALE datert ', ['30. juni 2026', 'DATE'], ' mellom ',
    ['Margrete Holmsen', 'PERSON'], ' (saksøker) og ',
    ['Nordavind Energi AS', 'COMPANY'],
    ' (saksøkte). Saksøkeren, bosatt i ', ['Hagegata 21', 'ADDRESS'], ', ',
    ['9008', 'ADDRESS'], ' ', ['Tromsø', 'ADDRESS'],
    ', mottar ', ['950 000 NOK', 'CURRENCY'],
    ' til full og endelig avgjørelse av saken. Saksøktes prosessfullmektig, advokat ',
    ['Pål Nystuen', 'PERSON'], ', nås på ', ['+47 77 55 01 88', 'PHONE'],
    '. Ingen av partene skal reise ny sak; hver part bærer egne omkostninger, og ingen vil sitte igjen med svarteper.',
  ]),

  // Uformell melding. Traps: "et helt berg av pølser", "må bo tett".
  doc('no-07', 'no', 'casual', [
    'Kjapt før jeg glemmer det: jeg booket hytta til ', ['22. august 2026', 'DATE'],
    ' og betalte depositumet med kortet ', ['5168 4402 7789 1235', 'CREDIT_CARD'],
    ', gyldig til 09/28. Det blir ', ['3 100 kr', 'CURRENCY'],
    ' per pers. ', ['Nadia', 'PERSON'], ' kjører, send melding til ',
    ['973 98 654', 'PHONE'], '. Min fetter ', ['Lars Haugland', 'PERSON'],
    ' blir kanskje med, han jobber i ', ['Torvfelt Media AS', 'COMPANY'],
    '. Han tar med grillen og et helt berg av pølser, så ingen sulter. Vi må bo tett, hytta er liten.',
  ]),

  // Søknadsskjema. Trap: "en sti bak skolen".
  doc('no-08', 'no', 'form', [
    'Søknadsskjema, kontoåpning.\nFullt navn: ', ['Frida Østgård', 'PERSON'],
    '\nFødselsdato: ', ['02.11.1990', 'DATE'],
    '\nFødselsnummer: ', ['02119012385', 'SSN', ['DATE']],
    '\nGateadresse: ', ['Sederstien 90', 'ADDRESS'],
    '\nPostnummer: ', ['0357', 'ADDRESS'],
    '\nPoststed: ', ['Oslo', 'ADDRESS'],
    '\nTelefon: ', ['22 55 01 99', 'PHONE'],
    '\nE-post: ', ['frida.ostgard@eksempelpost.no', 'EMAIL'],
    '\nArbeidsgiver: ', ['Concordia Biolab AS', 'COMPANY'],
    '\nMånedsinntekt: ', ['34 500 kr', 'CURRENCY'],
    '\nAnnet: ring helst ikke på mandager; da følger jeg barna langs en sti bak skolen.',
  ]),
];
