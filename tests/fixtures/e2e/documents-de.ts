import type { E2eDocument } from './types.ts';

export const DE_DOCUMENTS: E2eDocument[] = [
  {
    id: 'de-email-01',
    lang: 'de',
    kind: 'email',
    text: `Betreff: Rechnung RE-2024-031 und Überweisung

Sehr geehrte Frau Becker,

im Anschluss an mein Gespräch mit Herrn Stefan Hoffmann sende ich Ihnen die korrigierte Rechnung. Der Betrag von 4.800 EUR ist bis zum 15.03.2024 auf das Konto DE89 3704 0044 0532 0130 00 zu überweisen. Stefan Hoffmann hat bestätigt, dass die Rechnungsadresse Friedrichstraße 43, 10117 Berlin lautet.

Bei Rückfragen erreichen Sie ihn unter +49 30 1234567 oder per E-Mail an stefan.hoffmann@firma-beispiel.de. In Kopie geht diese Nachricht an Claudia Becker (claudia.becker@kunde-beispiel.de).

Mit freundlichen Grüßen
Sabine Vogel
Buchhaltung`,
    persons: ['Becker', 'Stefan Hoffmann', 'Claudia Becker', 'Sabine Vogel'],
    pii: [
      'Stefan Hoffmann', 'Claudia Becker', 'Sabine Vogel', '15.03.2024', 'DE89 3704 0044 0532 0130 00',
      'Friedrichstraße 43', '10117 Berlin', '+49 30 1234567', 'stefan.hoffmann@firma-beispiel.de',
      'claudia.becker@kunde-beispiel.de',
    ],
  },
  {
    id: 'de-email-02',
    lang: 'de',
    kind: 'email',
    text: `Guten Tag Herr Wagner,

hiermit bestätige ich den Abholtermin für Ihr Fahrzeug am 2024-04-02 um 10:00 Uhr. Bitte bringen Sie Ihren Personalausweis (Nummer T220001297) sowie den Nachweis der Anzahlung mit.

Den Vertrag unterschreibt Markus Wagner; die Abholung kann auch Petra Wagner bestätigen, wenn sie eine Vollmacht an service@autohaus-beispiel.de sendet. Unser Autohaus finden Sie in der Marktstraße 3, 80331 München, Telefon +49 89 987654.

Freundliche Grüße
Robert Schulz
Kundenberater`,
    persons: ['Wagner', 'Markus Wagner', 'Petra Wagner', 'Robert Schulz'],
    pii: [
      'Markus Wagner', 'Petra Wagner', 'Robert Schulz', '2024-04-02', 'T220001297', 'service@autohaus-beispiel.de',
      'Marktstraße 3', '80331 München', '+49 89 987654',
    ],
  },
  {
    id: 'de-email-03',
    lang: 'de',
    kind: 'email',
    text: `Hallo Tobias,

anbei die Daten für die Überweisung der Saalmiete: Empfängerin Annette Krüger, IBAN DE75 5121 0800 1245 1261 99, Verwendungszweck "Saal 20. April". Annette bittet um eine Bestätigung bis Freitag, den 26.04.2024.

Du kannst sie auch direkt anrufen: +49 171 2345678. Ihre E-Mail lautet a.krueger@vermietung-beispiel.de. Ich bin nach 14 Uhr unter tobias.lehmann@post-beispiel.de erreichbar.

Viele Grüße
Tobias Lehmann`,
    persons: ['Tobias', 'Annette Krüger', 'Annette', 'Tobias Lehmann'],
    pii: [
      'Annette Krüger', 'Tobias Lehmann', 'DE75 5121 0800 1245 1261 99', '26.04.2024', '+49 171 2345678',
      'a.krueger@vermietung-beispiel.de', 'tobias.lehmann@post-beispiel.de',
    ],
  },
  {
    id: 'de-contract-01',
    lang: 'de',
    kind: 'contract',
    text: `MIETVERTRAG FÜR WOHNRAUM

geschlossen am 01.02.2024 in Hamburg zwischen:

1. Christian Neumann, geboren am 11.02.1970, wohnhaft Goethestraße 7, 20095 Hamburg, nachfolgend Vermieter,
2. Monika Schäfer, geboren am 23.05.1992, wohnhaft Kurze Gasse 15, 20097 Hamburg, nachfolgend Mieterin.

Par. 1. Der Vermieter überlässt der Mieterin die Wohnung in der Goethestraße 7. Die Miete von 2.400 EUR monatlich zahlt die Mieterin bis zum 10. eines Monats auf das Konto DE89 3704 0044 0532 0130 00.

Par. 2. Mitteilungen an die Mieterin ergehen an monika.schaefer@post-beispiel.de oder telefonisch an +49 40 6001122. Christian Neumann nimmt Post persönlich entgegen.

Vermieter: Christian Neumann
Mieterin: Monika Schäfer`,
    persons: ['Christian Neumann', 'Monika Schäfer'],
    pii: [
      'Christian Neumann', 'Monika Schäfer', '01.02.2024', '11.02.1970', 'Goethestraße 7', '20095 Hamburg',
      '23.05.1992', 'Kurze Gasse 15', '20097 Hamburg', 'DE89 3704 0044 0532 0130 00',
      'monika.schaefer@post-beispiel.de', '+49 40 6001122',
    ],
  },
  {
    id: 'de-contract-02',
    lang: 'de',
    kind: 'contract',
    text: `WERKVERTRAG Nr. 7/2024

Auftraggeber: Grafikstudio Pixel GmbH, Hafenweg 22, 04109 Leipzig, vertreten durch den Geschäftsführer Matthias Koch.
Auftragnehmerin: Johanna Richter, Steuernummer 231/456/78901, wohnhaft Kastanienallee 4, 04105 Leipzig, E-Mail johanna.richter@grafik-beispiel.de, Tel. +49 341 9876543.

1. Die Auftragnehmerin verpflichtet sich, das Erscheinungsbild bis zum 30.06.2024 zu liefern.
2. Die Vergütung von 9.000 EUR ist auf das Konto der Auftragnehmerin DE75 5121 0800 1245 1261 99 innerhalb von 14 Tagen nach Abnahme zu zahlen.
3. Ansprechpartner auf Seiten des Auftraggebers ist Matthias Koch.

Auftraggeber: Matthias Koch
Auftragnehmerin: Johanna Richter`,
    persons: ['Matthias Koch', 'Johanna Richter'],
    pii: [
      'Matthias Koch', 'Johanna Richter', '231/456/78901', 'Kastanienallee 4', '04105 Leipzig',
      'johanna.richter@grafik-beispiel.de', '+49 341 9876543', '30.06.2024', 'DE75 5121 0800 1245 1261 99',
    ],
  },
  {
    id: 'de-contract-03',
    lang: 'de',
    kind: 'contract',
    text: `NACHTRAG Nr. 2 zum Arbeitsvertrag vom 15.09.2021

Arbeitgeber: Baustoffhandel Balken AG, Fabrikstraße 9, 70173 Stuttgart.
Arbeitnehmer: Andreas Zimmermann, geboren am 10.04.1979, wohnhaft Frühlingsweg 18, 70176 Stuttgart.

Die Parteien vereinbaren, dass Andreas Zimmermann ab dem 01.05.2024 die Stelle des Lagerleiters mit einem Bruttogehalt von 4.200 EUR übernimmt. Die übrigen Vertragsbedingungen bleiben unverändert.

Dienstlicher Kontakt: andreas.zimmermann@balken-beispiel.de, +49 711 1112233. Das Gehalt wird auf das Konto DE89 3704 0044 0532 0130 00 überwiesen.

Für den Arbeitgeber: Elisabeth Braun, Personalleiterin
Arbeitnehmer: Andreas Zimmermann`,
    persons: ['Andreas Zimmermann', 'Elisabeth Braun'],
    pii: [
      'Andreas Zimmermann', 'Elisabeth Braun', '15.09.2021', '10.04.1979', 'Frühlingsweg 18', '70176 Stuttgart',
      '01.05.2024', 'andreas.zimmermann@balken-beispiel.de', '+49 711 1112233', 'DE89 3704 0044 0532 0130 00',
    ],
  },
  {
    id: 'de-cv-01',
    lang: 'de',
    kind: 'cv',
    text: `MAGDALENA FISCHER
Datenanalystin

Kontakt: magdalena.fischer@cv-beispiel.de | +49 151 2345678 | Akazienweg 5, 50667 Köln
Geburtsdatum: 12.07.1991

Berufserfahrung
2020-2024 Datenanalystin, Onlineshop Punkt GmbH, Köln. Aufbau des Vertriebsreportings, enge Zusammenarbeit mit dem Team von Benedikt Meyer.
2017-2020 Junior-Analystin, Regionalbank AG, Bonn.

Ausbildung
2012-2017 Universität zu Köln, Angewandte Mathematik.

Referenz: Benedikt Meyer, Teamleiter, benedikt.meyer@punkt-beispiel.de.

Ich willige in die Verarbeitung meiner personenbezogenen Daten zum Zweck der Bewerbung ein.`,
    persons: ['MAGDALENA FISCHER', 'Benedikt Meyer'],
    pii: [
      'Magdalena Fischer', 'Benedikt Meyer', 'magdalena.fischer@cv-beispiel.de', '+49 151 2345678', 'Akazienweg 5',
      '50667 Köln', '12.07.1991', 'benedikt.meyer@punkt-beispiel.de',
    ],
  },
  {
    id: 'de-cv-02',
    lang: 'de',
    kind: 'cv',
    text: `Lukas Schneider
Instandhaltungsingenieur

Anschrift: Spazierweg 31, 28195 Bremen
Telefon: +49 421 5551234
E-Mail: lukas.schneider@cv-beispiel.de
Geboren am 03.11.1987

Profil
Mehr als zehn Jahre Erfahrung an Produktionslinien. Verantwortlich für die Planung von Inspektionen und die Führung eines Teams von sechs Technikern. Das letzte Projekt habe ich gemeinsam mit Dorothea Hartmann geleitet.

Beschäftigung
2016-2024 Maschinenwerke Welle AG, Bremen, Instandhaltungsingenieur.
2011-2016 Nordwerft GmbH, Bremerhaven, Techniker.

Referenz: Dorothea Hartmann, Produktionsleiterin, Tel. +49 421 5559876.`,
    persons: ['Lukas Schneider', 'Dorothea Hartmann'],
    pii: [
      'Lukas Schneider', 'Dorothea Hartmann', 'Spazierweg 31', '28195 Bremen', '+49 421 5551234',
      'lukas.schneider@cv-beispiel.de', '03.11.1987', '+49 421 5559876',
    ],
  },
  {
    id: 'de-note-01',
    lang: 'de',
    kind: 'note',
    text: `Protokoll der Projektbesprechung, 2024-05-14

Anwesend: Paul Werner (Projektleiter), Justine Krause (Rechtsabteilung), Ralf Lange (Kunde).

1. Ralf Lange hat seine Anmerkungen zum Zeitplan vorgestellt. Der Einführungstermin wird auf den 30.09.2024 verschoben.
2. Justine Krause bereitet den Nachtrag zum Vertrag vor; den Entwurf schickt sie bis Ende der Woche an ralf.lange@kunde-beispiel.de.
3. Paul holt Angebote für die Zusatzarbeiten ein. Kontakt des Dienstleisters: +49 170 4445556.
4. Abschlagsrechnungen gehen an die Adresse des Kunden: Grüne Straße 8, 01067 Dresden.

Nächstes Treffen: 28.05.2024 im Büro des Kunden. Protokoll: Paul Werner.`,
    persons: ['Paul Werner', 'Justine Krause', 'Ralf Lange', 'Paul'],
    pii: [
      'Paul Werner', 'Justine Krause', 'Ralf Lange', '2024-05-14', '30.09.2024', 'ralf.lange@kunde-beispiel.de',
      '+49 170 4445556', 'Grüne Straße 8', '01067 Dresden', '28.05.2024',
    ],
  },
  {
    id: 'de-note-02',
    lang: 'de',
    kind: 'note',
    text: `Aktennotiz vom 03.06.2024

Betreff: Reklamation zur Bestellung Nr. 4471

Im Telefonat (+49 30 6007080) meldete Peter Zimmer eine Beschädigung der am 31.05.2024 an die Adresse Pappelweg 2, 14467 Potsdam gelieferten Sendung. Auf Seiten des Lagers hat Peter Maurer den Fall geprüft. Peter bestätigte, dass das Paket gemäß Vorschrift verpackt war.

Ergebnis: Der Kunde erhält bis zum 10.06.2024 eine Ersatzlieferung; die Rücksendekosten (120 EUR) trägt das Unternehmen. Die Bestätigung ging an peter.zimmer@kunde-beispiel.de.

Verfasst von: Beate Jansen, Kundenservice`,
    // "Peter" alone fits two people: the session must not guess (R5).
    persons: ['Peter Zimmer', 'Peter Maurer', 'Peter', 'Beate Jansen'],
    pii: [
      'Peter Zimmer', 'Peter Maurer', 'Beate Jansen', '03.06.2024', '+49 30 6007080', '31.05.2024', 'Pappelweg 2',
      '14467 Potsdam', '10.06.2024', 'peter.zimmer@kunde-beispiel.de',
    ],
  },
];
