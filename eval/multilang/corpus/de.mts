/**
 * T124 gold corpus: German (Deutschland).
 * Authored as segments; offsets computed by doc(). See ../schema.mts.
 */
import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  // Onboarding-E-Mail. Traps: "Berliner" (Gebaeck), "im Mai".
  doc('de-01', 'de', 'email', [
    'Liebes Team, bitte richtet für ', ['Katharina Möller', 'PERSON'],
    ' ab dem ', ['01.09.2026', 'DATE'],
    ' einen Zugang ein. Ihre E-Mail lautet ', ['k.moeller@beispielfirma.de', 'EMAIL'],
    ', mobil ist sie unter ', ['+49 171 2345678', 'PHONE'],
    ' erreichbar. Sie arbeitet künftig im Büro der ', ['Rheinwerk Datentechnik GmbH', 'COMPANY'],
    ', ', ['Kastanienallee 12', 'ADDRESS'], ', ', ['10435', 'ADDRESS'], ' ',
    ['Berlin', 'ADDRESS'],
    '. Bringt zum Einstand bitte Berliner mit, im Mai kamen die auch super an.',
  ]),

  // Chat-Nachricht an einen KI-Assistenten. Traps: "beleidigte Leberwurst", "frankfurter Anwaltsdeutsch".
  doc('de-02', 'de', 'chat', [
    'Hallo, kannst du mir eine höfliche Absage formulieren? ',
    ['Tobias Brandt', 'PERSON'], ' von der ', ['Falkenstein Logistik AG', 'COMPANY'],
    ' hat mir ein Angebot geschickt und bittet um Rückruf unter ',
    ['0170 9876543', 'PHONE'], '. Seine Mail ist ', ['t.brandt@falkenstein-log.de', 'EMAIL'],
    '. Er will bis zum ', ['15.10.2026', 'DATE'],
    ' eine Zusage, aber sein Preis von ', ['4.890,00 EUR', 'CURRENCY'],
    ' ist mir zu hoch. Der Testserver läuft übrigens auf ', ['192.0.2.77', 'IP_ADDRESS'],
    ', falls das relevant ist. Bitte freundlich bleiben, ich will nicht als beleidigte Leberwurst dastehen, und bitte ohne frankfurter Anwaltsdeutsch.',
  ]),

  // Personalakte. Trap: "Kohl" (Gemuese).
  doc('de-03', 'de', 'hr', [
    'VERTRAULICH, Personalakte. Mitarbeiterin: ', ['Sabine Kretschmer', 'PERSON'],
    ', geboren am ', ['12.03.1985', 'DATE'],
    '. Steuer-Identifikationsnummer: ', ['45 786 123 490', 'SSN'],
    '. Anschrift: ', ['Lindenstraße 47', 'ADDRESS'], ', ', ['04177', 'ADDRESS'], ' ',
    ['Leipzig', 'ADDRESS'],
    '. Telefon: ', ['0341 4922718', 'PHONE'],
    ', privat ', ['sabine.kretschmer@mailbeispiel.de', 'EMAIL'], '. Frau ',
    ['Kretschmer', 'PERSON'], ' ist seit dem ', ['01.02.2018', 'DATE'],
    ' bei uns und verdient ', ['58.300,00 Euro', 'CURRENCY'],
    ' brutto im Jahr. Anmerkung: In der Kantine nimmt sie am liebsten Kohl, und ihr Schreibtisch steht am Fenster.',
  ]),

  // Aufnahmebogen Klinik. Traps: "Currywurst", "beim Essen".
  doc('de-04', 'de', 'medical', [
    'Aufnahmebogen. Patient: ', ['Jürgen Habermann', 'PERSON'],
    ', geb. ', ['22.07.1954', 'DATE'],
    '. Aufnahme am ', ['04.08.2026', 'DATE'],
    ' wegen anhaltender Rückenschmerzen. Notfallkontakt: seine Tochter ',
    ['Ulrike Habermann', 'PERSON'], ', Telefon ', ['+49 89 55501420', 'PHONE'],
    '. Versichert bei der ', ['Bavaria Krankenversicherung AG', 'COMPANY'],
    '. Wohnanschrift: ', ['Am Mühlbach 3', 'ADDRESS'], ', ', ['82319', 'ADDRESS'],
    ' ', ['Starnberg', 'ADDRESS'],
    '. Der Patient fragt, ob eine Currywurst pro Woche in Ordnung sei; er möchte beim Essen sonst nichts umstellen.',
  ]),

  // Rechnung. Trap: "Diesel-Zuschlag".
  doc('de-05', 'de', 'invoice', [
    'RECHNUNG Nr. 2026-0311 vom ', ['10.04.2026', 'DATE'],
    '. Aussteller: ', ['Werkbund Schreinerei GmbH & Co. KG', 'COMPANY'], ', ',
    ['Industriestraße 8', 'ADDRESS'], ', ', ['70565', 'ADDRESS'], ' ',
    ['Stuttgart', 'ADDRESS'],
    '. Rechnungsempfängerin: ', ['Dr. Annette Vogel', 'PERSON'],
    '. Rechnungsbetrag: ', ['1.250,00 EUR', 'CURRENCY'],
    '. Bitte überweisen Sie den Betrag binnen 14 Tagen auf das Konto IBAN ',
    ['DE89 3704 0044 0532 0130 00', 'IBAN'],
    '. Rückfragen an ', ['buchhaltung@werkbund-schreinerei.de', 'EMAIL'],
    ' oder ', ['0711 4568920', 'PHONE'],
    '. Ein Diesel-Zuschlag für die Anlieferung wurde nicht berechnet.',
  ]),

  // Vergleichsvereinbarung. Traps: "schwarzen Peter", "Fass ohne Boden".
  doc('de-06', 'de', 'legal', [
    'VERGLEICHSVEREINBARUNG vom ', ['30.06.2026', 'DATE'], ' zwischen ',
    ['Marlene Steinbach', 'PERSON'], ' (Klägerin) und der ',
    ['Nordwind Energie SE', 'COMPANY'],
    ' (Beklagte). Die Klägerin, wohnhaft ', ['Gartenweg 21', 'ADDRESS'], ', ',
    ['24103', 'ADDRESS'], ' ', ['Kiel', 'ADDRESS'],
    ', erhält zur Abgeltung sämtlicher Ansprüche ', ['95.000,00 Euro', 'CURRENCY'],
    '. Der Prozessbevollmächtigte der Beklagten, Rechtsanwalt ',
    ['Falk Neudecker', 'PERSON'], ', ist unter ', ['+49 431 5550188', 'PHONE'],
    ' erreichbar. Jede Partei trägt ihre Kosten selbst; keiner will den schwarzen Peter, und ein weiterer Prozess wäre ein Fass ohne Boden.',
  ]),

  // Lockere Nachricht. Trap: "Hamburger Grill".
  doc('de-07', 'de', 'casual', [
    'Kurz bevor ich es vergesse: Ich habe die Hütte für den ', ['22.08.2026', 'DATE'],
    ' gebucht und die Anzahlung mit meiner Karte ', ['5355 8412 9034 7712', 'CREDIT_CARD'],
    ' bezahlt, gültig bis 09/28. Pro Person macht das ', ['310 Euro', 'CURRENCY'],
    '. ', ['Nadja', 'PERSON'], ' fährt, schreib ihr unter ', ['0151 23456789', 'PHONE'],
    '. Mein Cousin ', ['Lukas Hartmann', 'PERSON'],
    ' kommt vielleicht auch mit, der arbeitet bei ', ['Torfeld Medien GmbH', 'COMPANY'],
    '. Er bringt seinen Hamburger Grill mit, also keine Sorge wegen der Verpflegung.',
  ]),

  // Antragsformular. Trap: "Amerikaner" (Gebaeck).
  doc('de-08', 'de', 'form', [
    'Antragsformular Kontoeröffnung.\nVollständiger Name: ', ['Friederike Oster', 'PERSON'],
    '\nGeburtsdatum: ', ['02.11.1990', 'DATE'],
    '\nSteuer-ID: ', ['86 095 742 719', 'SSN'],
    '\nStraße und Hausnummer: ', ['Zedernweg 90', 'ADDRESS'],
    '\nPLZ: ', ['50823', 'ADDRESS'],
    '\nOrt: ', ['Köln', 'ADDRESS'],
    '\nTelefon: ', ['0221 5550199', 'PHONE'],
    '\nE-Mail: ', ['f.oster@beispielpost.de', 'EMAIL'],
    '\nArbeitgeber: ', ['Concordia Biolabor GmbH', 'COMPANY'],
    '\nMonatliches Nettoeinkommen: ', ['3.450,00 EUR', 'CURRENCY'],
    '\nBemerkung: Rückruf bitte nicht montags, da hole ich beim Bäcker Amerikaner für die Kinder.',
  ]),
];
