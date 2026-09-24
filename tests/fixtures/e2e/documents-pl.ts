import type { E2eDocument } from './types.ts';

export const PL_DOCUMENTS: E2eDocument[] = [
  {
    id: 'pl-email-01',
    lang: 'pl',
    kind: 'email',
    text: `Temat: Faktura FV/2024/031 i przelew

Szanowna Pani Anno,

w nawiązaniu do rozmowy z panem Janem Kowalskim przesyłam korektę faktury. Kwota 4 800 zł powinna trafić na rachunek PL61 1090 1014 0000 0712 1981 2874 do dnia 15.03.2024. Jan Kowalski potwierdził, że adres do korespondencji to ul. Długa 12, 00-950 Warszawa.

W razie pytań proszę o kontakt pod numerem +48 601 234 567 albo mailowo: jan.kowalski@firma-przyklad.pl. Kopię wysyłam też do Anny Nowak (anna.nowak@klient-przyklad.pl).

Z poważaniem,
Marta Zielińska
Dział rozliczeń`,
    persons: ['Anno', 'Janem Kowalskim', 'Jan Kowalski', 'Anny Nowak', 'Marta Zielińska'],
    pii: [
      'Jan Kowalski', 'Janem Kowalskim', 'Anny Nowak', 'Marta Zielińska',
      'PL61 1090 1014 0000 0712 1981 2874', '15.03.2024', 'ul. Długa 12', '00-950 Warszawa',
      '+48 601 234 567', 'jan.kowalski@firma-przyklad.pl', 'anna.nowak@klient-przyklad.pl',
    ],
  },
  {
    id: 'pl-email-02',
    lang: 'pl',
    kind: 'email',
    text: `Dzień dobry Panie Tomaszu,

potwierdzam termin odbioru samochodu na 2024-04-02 o godzinie 10:00. Proszę zabrać dowód osobisty (numer PESEL 85010112345 musi zgadzać się z umową) oraz potwierdzenie wpłaty zaliczki.

Umowę podpisuje Tomasz Wiśniewski, a w jego imieniu odbiór może potwierdzić Katarzyna Wiśniewska, jeśli prześle upoważnienie na adres serwis@auto-przyklad.pl. Nasz salon mieści się przy ul. Wąskiej 3, 30-001 Kraków, telefon +48 12 345 67 89.

Pozdrawiam serdecznie,
Robert Mazur
Doradca klienta`,
    persons: ['Tomaszu', 'Tomasz Wiśniewski', 'Katarzyna Wiśniewska', 'Robert Mazur'],
    pii: [
      'Tomasz Wiśniewski', 'Katarzyna Wiśniewska', 'Robert Mazur', '2024-04-02', '85010112345',
      'serwis@auto-przyklad.pl', 'ul. Wąskiej 3', '30-001 Kraków', '+48 12 345 67 89',
    ],
  },
  {
    id: 'pl-email-03',
    lang: 'pl',
    kind: 'email',
    text: `Cześć Piotrek,

przesyłam dane do przelewu za wynajem sali: odbiorca Agnieszka Kamińska, IBAN PL10 1050 0099 7603 1234 5678 9123, tytuł "sala 20 kwietnia 2024". Agnieszka prosiła o potwierdzenie do piątku.

Jeśli chcesz, zadzwoń do niej bezpośrednio: +48 512 987 654. Jej mail to a.kaminska@wynajem-przyklad.pl. Ja będę dostępny po 14:00 pod adresem piotr.lewandowski@poczta-przyklad.pl.

Pozdrawiam,
Piotr Lewandowski`,
    persons: ['Piotrek', 'Agnieszka Kamińska', 'Agnieszka', 'Piotr Lewandowski'],
    pii: [
      'Agnieszka Kamińska', 'Piotr Lewandowski', 'PL10 1050 0099 7603 1234 5678 9123', '20 kwietnia 2024',
      '+48 512 987 654', 'a.kaminska@wynajem-przyklad.pl', 'piotr.lewandowski@poczta-przyklad.pl',
    ],
  },
  {
    id: 'pl-contract-01',
    lang: 'pl',
    kind: 'contract',
    text: `UMOWA NAJMU LOKALU MIESZKALNEGO

zawarta w dniu 01.02.2024 w Poznaniu pomiędzy:

1. Krzysztofem Dąbrowskim, PESEL 70112233445, zamieszkałym przy ul. Słowackiego 7, 60-001 Poznań, zwanym dalej Wynajmującym,
2. Moniką Krawczyk, PESEL 92052398765, zamieszkałą przy ul. Cichej 15, 61-002 Poznań, zwaną dalej Najemcą.

Par. 1. Wynajmujący oddaje Najemcy w najem lokal przy ul. Słowackiego 7. Czynsz w wysokości 2 400 zł miesięcznie Najemca wpłaca na rachunek PL61 1090 1014 0000 0712 1981 2874 do 10. dnia każdego miesiąca.

Par. 2. Wszelkie zawiadomienia kierowane do Najemcy przesyła się na adres monika.krawczyk@poczta-przyklad.pl lub telefonicznie na numer +48 600 111 222. Krzysztof Dąbrowski odbiera korespondencję osobiście.

Wynajmujący: Krzysztof Dąbrowski
Najemca: Monika Krawczyk`,
    persons: ['Krzysztofem Dąbrowskim', 'Moniką Krawczyk', 'Krzysztof Dąbrowski', 'Monika Krawczyk'],
    pii: [
      'Krzysztof Dąbrowski', 'Monika Krawczyk', '01.02.2024', '70112233445', '92052398765',
      'ul. Słowackiego 7', '60-001 Poznań', 'ul. Cichej 15', '61-002 Poznań',
      'PL61 1090 1014 0000 0712 1981 2874', 'monika.krawczyk@poczta-przyklad.pl', '+48 600 111 222',
    ],
  },
  {
    id: 'pl-contract-02',
    lang: 'pl',
    kind: 'contract',
    text: `UMOWA O DZIEŁO nr 7/2024

Zamawiający: Studio Graficzne Pixel Sp. z o.o., ul. Fabryczna 22, 90-001 Łódź, reprezentowana przez Prezesa Zarządu Marka Szymańskiego.
Wykonawca: Joanna Wójcik, PESEL 88031566778, zamieszkała ul. Jesionowa 4, 91-002 Łódź, e-mail joanna.wojcik@grafika-przyklad.pl, tel. +48 693 000 111.

1. Wykonawca zobowiązuje się wykonać identyfikację wizualną do dnia 30.06.2024.
2. Wynagrodzenie w kwocie 9 000 zł płatne na rachunek Wykonawcy PL10 1050 0099 7603 1234 5678 9123 w terminie 14 dni od odbioru dzieła.
3. Osobą kontaktową po stronie Zamawiającego jest Marek Szymański.

Zamawiający: Marek Szymański
Wykonawca: Joanna Wójcik`,
    persons: ['Marka Szymańskiego', 'Joanna Wójcik', 'Marek Szymański'],
    pii: [
      'Marek Szymański', 'Marka Szymańskiego', 'Joanna Wójcik', '88031566778', 'ul. Jesionowa 4', '91-002 Łódź',
      'joanna.wojcik@grafika-przyklad.pl', '+48 693 000 111', '30.06.2024', 'PL10 1050 0099 7603 1234 5678 9123',
    ],
  },
  {
    id: 'pl-contract-03',
    lang: 'pl',
    kind: 'contract',
    text: `ANEKS nr 2 do umowy o pracę z dnia 15.09.2021

Pracodawca: Hurtownia Budowlana Belka S.A., ul. Fabryczna 9, 40-001 Katowice.
Pracownik: Andrzej Grabowski, PESEL 79041011223, zamieszkały ul. Jarzębinowa 18, 41-002 Chorzów.

Strony zgodnie postanawiają, że od dnia 01.05.2024 Andrzej Grabowski obejmuje stanowisko kierownika magazynu z wynagrodzeniem 8 200 zł brutto. Pozostałe warunki umowy nie ulegają zmianie.

Kontakt służbowy pracownika: andrzej.grabowski@belka-przyklad.pl, +48 32 111 22 33. Wynagrodzenie przekazywane będzie na rachunek PL61 1090 1014 0000 0712 1981 2874.

Za Pracodawcę: Elżbieta Jaworska, Dyrektor HR
Pracownik: Andrzej Grabowski`,
    persons: ['Andrzej Grabowski', 'Elżbieta Jaworska'],
    pii: [
      'Andrzej Grabowski', 'Elżbieta Jaworska', '15.09.2021', '79041011223', 'ul. Jarzębinowa 18', '41-002 Chorzów',
      '01.05.2024', 'andrzej.grabowski@belka-przyklad.pl', '+48 32 111 22 33', 'PL61 1090 1014 0000 0712 1981 2874',
    ],
  },
  {
    id: 'pl-cv-01',
    lang: 'pl',
    kind: 'cv',
    text: `MAGDALENA PAWLAK
Analityczka danych

Kontakt: magdalena.pawlak@cv-przyklad.pl | +48 507 123 456 | ul. Cisowa 5, 50-001 Wrocław
Data urodzenia: 12.07.1991 | PESEL 91071244556

Doświadczenie
2020-2024 Analityczka danych, Sklep Internetowy Kropka Sp. z o.o., Wrocław. Budowa raportów sprzedażowych, współpraca z zespołem Bartosza Nowickiego.
2017-2020 Młodsza analityczka, Bank Regionalny S.A., Opole.

Wykształcenie
2012-2017 Uniwersytet Ekonomiczny, matematyka stosowana.

Referencje: Bartosz Nowicki, kierownik zespołu, bartosz.nowicki@kropka-przyklad.pl.

Wyrażam zgodę na przetwarzanie moich danych osobowych w celu rekrutacji.`,
    persons: ['MAGDALENA PAWLAK', 'Bartosza Nowickiego', 'Bartosz Nowicki'],
    pii: [
      'Magdalena Pawlak', 'Bartosz Nowicki', 'Bartosza Nowickiego', 'magdalena.pawlak@cv-przyklad.pl',
      '+48 507 123 456', 'ul. Cisowa 5', '50-001 Wrocław', '12.07.1991', '91071244556',
      'bartosz.nowicki@kropka-przyklad.pl',
    ],
  },
  {
    id: 'pl-cv-02',
    lang: 'pl',
    kind: 'cv',
    text: `Łukasz Kaczmarek
Inżynier utrzymania ruchu

Adres: ul. Żeglarska 31, 80-001 Gdańsk
Telefon: +48 511 222 333
E-mail: lukasz.kaczmarek@cv-przyklad.pl
Urodzony 03.11.1987, PESEL 87110355667

Profil zawodowy
Ponad dziesięć lat pracy przy liniach produkcyjnych. Odpowiedzialny za planowanie przeglądów i nadzór nad zespołem sześciu techników. Ostatni projekt prowadziłem wspólnie z Dorotą Sobczak.

Zatrudnienie
2016-2024 Zakłady Mechaniczne Fala S.A., Gdańsk, inżynier utrzymania ruchu.
2011-2016 Stocznia Północna Sp. z o.o., Gdynia, technik.

Osoba polecająca: Dorota Sobczak, dyrektor produkcji, tel. +48 58 300 40 50.`,
    persons: ['Łukasz Kaczmarek', 'Dorotą Sobczak', 'Dorota Sobczak'],
    pii: [
      'Łukasz Kaczmarek', 'Dorota Sobczak', 'Dorotą Sobczak', 'ul. Żeglarska 31', '80-001 Gdańsk', '+48 511 222 333',
      'lukasz.kaczmarek@cv-przyklad.pl', '03.11.1987', '87110355667', '+48 58 300 40 50',
    ],
  },
  {
    id: 'pl-note-01',
    lang: 'pl',
    kind: 'note',
    text: `Notatka ze spotkania projektowego, 2024-05-14

Obecni: Paweł Zawadzki (kierownik projektu), Justyna Michalska (prawnik), Rafał Olszewski (klient).

1. Rafał Olszewski przedstawił uwagi do harmonogramu. Termin wdrożenia przesunięty na 30.09.2024.
2. Justyna Michalska przygotuje aneks do umowy; wzór wyśle na adres rafal.olszewski@klient-przyklad.pl do końca tygodnia.
3. Paweł zbierze wycenę dodatkowych prac. Kontakt do wykonawcy: +48 604 555 666.
4. Faktury zaliczkowe będą wystawiane na dane klienta: ul. Modra 8, 70-001 Szczecin.

Następne spotkanie: 28.05.2024, biuro klienta. Notatkę sporządził Paweł Zawadzki.`,
    persons: ['Paweł Zawadzki', 'Justyna Michalska', 'Rafał Olszewski', 'Paweł'],
    pii: [
      'Paweł Zawadzki', 'Justyna Michalska', 'Rafał Olszewski', '2024-05-14', '30.09.2024',
      'rafal.olszewski@klient-przyklad.pl', '+48 604 555 666', 'ul. Modra 8', '70-001 Szczecin', '28.05.2024',
    ],
  },
  {
    id: 'pl-note-02',
    lang: 'pl',
    kind: 'note',
    text: `Notatka służbowa z dnia 03.06.2024

Temat: reklamacja zamówienia nr 4471

W rozmowie telefonicznej (+48 22 600 70 80) Piotr Zieliński zgłosił uszkodzenie przesyłki dostarczonej 31.05.2024 na adres ul. Dębowa 2, 05-500 Piaseczno. Sprawę po stronie magazynu wyjaśniał Piotr Mazur. Piotr potwierdził, że paczka była zapakowana zgodnie z procedurą.

Ustalenia: klient otrzyma nową przesyłkę do 10.06.2024, a koszt zwrotu (120 zł) pokryje firma. Potwierdzenie wysłano na piotr.zielinski@klient-przyklad.pl.

Sporządziła: Beata Jankowska, obsługa klienta`,
    // "Piotr" alone fits two people: the session must not guess (R5).
    persons: ['Piotr Zieliński', 'Piotr Mazur', 'Piotr', 'Beata Jankowska'],
    pii: [
      'Piotr Zieliński', 'Piotr Mazur', 'Beata Jankowska', '03.06.2024', '+48 22 600 70 80', '31.05.2024',
      'ul. Dębowa 2', '05-500 Piaseczno', '10.06.2024', 'piotr.zielinski@klient-przyklad.pl',
    ],
  },
];
