/**
 * T124 gold corpus: Polish (pl). 8 docs, genres email/chat/hr/medical/invoice/legal/casual/form.
 * All identities fictional; identifiers structurally correct, checksums not guaranteed.
 * Plain-text ambiguity traps (not gold): month names mid-sentence (w maju, w marcu,
 * w grudniu), "kowal"/"kowalstwo" (the blacksmith), city adjectives in food names
 * (kielbasa krakowska, pierogi ruskie, sledz po japonsku).
 */

import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  doc('pl-01', 'pl', 'email', [
    'Szanowna Pani, w nawiązaniu do rozmowy z ', ['Markiem Zielińskim', 'PERSON'],
    ' z firmy ', ['Nordex Logistyka Sp. z o.o.', 'COMPANY'],
    ' przesyłam dane do umowy. Proszę o odpowiedź na adres ',
    ['m.zielinski@nordexlog.pl', 'EMAIL'], ' lub telefonicznie pod numerem ',
    ['+48 601 234 567', 'PHONE'], ' do dnia ', ['15 marca 2026', 'DATE'],
    '. Faktura opiewa na kwotę ', ['12 450,00 zł', 'CURRENCY'],
    ' i jest płatna przelewem na rachunek ', ['PL61 1090 1014 0000 0712 1981 2874', 'IBAN'],
    '. W maju planujemy kolejne spotkanie projektowe, o terminie poinformujemy osobno. Z poważaniem, ',
    ['Anna Nowicka', 'PERSON'], '.',
  ]),

  doc('pl-02', 'pl', 'chat', [
    'Hej, pomóż mi napisać reklamację. Kupiłem laptopa od ', ['Piotra Wiśniewskiego', 'PERSON'],
    ' przez portal ogłoszeniowy. Sprzedawca podał numer ', ['512-887-013', 'PHONE'],
    ' i adres ', ['piotr.wisniewski85@poczta.onet.pl', 'EMAIL'],
    '. Zapłaciłem ', ['3 200 zł', 'CURRENCY'], ' kartą ', ['4532 7789 1023 4456', 'CREDIT_CARD'],
    ' w dniu ', ['3.02.2026', 'DATE'], '. Paczka miała przyjść na ',
    ['ul. Długa 14/3', 'ADDRESS'], ', ', ['31-147', 'ADDRESS'], ' ', ['Kraków', 'ADDRESS'],
    '. Według portalu sprzedawca logował się ostatnio z adresu ', ['185.246.208.77', 'IP_ADDRESS'],
    '. W ogłoszeniu obiecywał wysyłkę jeszcze w marcu, a potem przestał odpowiadać. Możesz zaproponować treść pisma?',
  ]),

  doc('pl-03', 'pl', 'hr', [
    'Notatka kadrowa. Pracownik: ', ['Katarzyna Dąbrowska', 'PERSON'],
    ', zatrudniona w spółce ', ['Helios Media S.A.', 'COMPANY'],
    ' od ', ['1 września 2024', 'DATE'], ', urodzona ', ['12.03.1985', 'DATE'],
    ', PESEL ', ['85031204567', 'SSN', ['DATE']],
    '. Adres zamieszkania: ', ['ul. Słoneczna 8', 'ADDRESS'], ', ',
    ['02-495', 'ADDRESS'], ' ', ['Warszawa', 'ADDRESS'],
    '. Wynagrodzenie zasadnicze wynosi ', ['8 900 zł', 'CURRENCY'],
    ' brutto. Wniosek urlopowy zaakceptowany przez przełożonego, pana ',
    ['Tomasza Gajewskiego', 'PERSON'], '. Telefon służbowy: ', ['22 512 60 88', 'PHONE'],
    '. W aktach znajduje się list polecający od mistrza kowalstwa z technikum, gdzie odbywała praktyki. Ocena roczna planowana w grudniu.',
  ]),

  doc('pl-04', 'pl', 'medical', [
    'Karta informacyjna leczenia szpitalnego. Pacjent: ', ['Stanisław Wójcik', 'PERSON'],
    ', ur. ', ['7 lipca 1958', 'DATE'], ', PESEL ', ['58070791234', 'SSN', ['DATE']],
    '. Przyjęty dnia ', ['21.01.2026', 'DATE'],
    ' z powodu bólu w klatce piersiowej. Lekarz prowadzący: dr ', ['Ewa Baran', 'PERSON'],
    '. Kontakt do rodziny: syn, tel. ', ['+48 693 552 018', 'PHONE'],
    '. Zalecenia: kontrola w poradni kardiologicznej przy ', ['ul. Ogrodowej 22', 'ADDRESS'],
    ' w ', ['Poznaniu', 'ADDRESS'],
    ' za dwa tygodnie. Dieta lekkostrawna, bez pierogów ruskich i śledzia po japońsku, ograniczyć sól.',
  ]),

  doc('pl-05', 'pl', 'invoice', [
    'Faktura VAT nr FV/2026/02/117. Sprzedawca: ', ['Bartex Meble Sp. j.', 'COMPANY'],
    ', NIP ', ['7792433421', 'SSN'], ', ', ['ul. Fabryczna 5', 'ADDRESS'], ', ',
    ['61-512', 'ADDRESS'], ' ', ['Poznań', 'ADDRESS'],
    '. Nabywca: ', ['Michał Krajewski', 'PERSON'], ', e-mail ',
    ['m.krajewski@interia.pl', 'EMAIL'], '. Data wystawienia: ', ['28.02.2026', 'DATE'],
    '. Razem do zapłaty: ', ['4 815,60 zł', 'CURRENCY'],
    '. Płatność przelewem na konto ', ['PL27 1140 2004 0000 3002 0135 5387', 'IBAN'],
    ' w terminie 14 dni. Towar: stół dębowy i cztery krzesła bukowe, dostawa pod koniec marca.',
  ]),

  doc('pl-06', 'pl', 'legal', [
    'Umowa najmu lokalu mieszkalnego zawarta w dniu ', ['5 stycznia 2026', 'DATE'],
    ' pomiędzy ', ['Heleną Mazur', 'PERSON'], ', zamieszkałą przy ',
    ['ul. Wiejskiej 3a', 'ADDRESS'], ' w ', ['Lublinie', 'ADDRESS'],
    ', zwaną dalej Wynajmującą, a ', ['Pawłem Sikorą', 'PERSON'],
    ', legitymującym się numerem PESEL ', ['91042215678', 'SSN', ['DATE']],
    ', zwanym dalej Najemcą. Czynsz w wysokości ', ['2 600 zł', 'CURRENCY'],
    ' miesięcznie płatny na rachunek ', ['PL84 1020 5558 0000 8402 3012 6711', 'IBAN'],
    ' do 10. dnia każdego miesiąca. Kontakt do Wynajmującej: ', ['helena.mazur@wp.pl', 'EMAIL'],
    ', tel. ', ['604 118 902', 'PHONE'],
    '. Kaucja podlega zwrotowi w maju po zakończeniu okresu najmu i rozliczeniu drobnych napraw.',
  ]),

  doc('pl-07', 'pl', 'casual', [
    'Wyobraź sobie, że wczoraj na rynku spotkałam ', ['Olę Szymańską', 'PERSON'],
    ' pierwszy raz od studiów! Umówiłyśmy się na pierogi ruskie i sernik. Dała mi swój nowy numer ',
    ['+48 727 445 990', 'PHONE'], ' i powiedziała, że pracuje teraz w ',
    ['Studio Graficzne Kreska', 'COMPANY'], '. Mieszka gdzieś przy ',
    ['ul. Kwiatowej 17', 'ADDRESS'], ' w ', ['Gdańsku', 'ADDRESS'],
    ', wprowadzili się ', ['10 listopada 2025', 'DATE'],
    '. Za kawę i ciasto zapłaciłam ', ['38 zł', 'CURRENCY'],
    '. Kelner wyglądał jak stary kowal, taki wąsaty. Na wynos wzięłyśmy jeszcze kiełbasę krakowską dla chłopaków.',
  ]),

  doc('pl-08', 'pl', 'form', [
    'Formularz zgłoszeniowy - serwis internetowy.\nImię i nazwisko: ',
    ['Rafał Nowakowski', 'PERSON'], '\nData urodzenia: ', ['02.11.1990', 'DATE'],
    '\nPESEL: ', ['90110204321', 'SSN', ['DATE']],
    '\nAdres: ', ['ul. Polna 44', 'ADDRESS'], ', ', ['50-039', 'ADDRESS'], ' ',
    ['Wrocław', 'ADDRESS'], '\nTelefon: ', ['71 344 21 56', 'PHONE'],
    '\nE-mail: ', ['rafal.nowakowski90@gmail.com', 'EMAIL'],
    '\nNumer karty do płatności cyklicznych: ', ['5168 4402 7719 3320', 'CREDIT_CARD'],
    '\nAdres IP rejestracji: ', ['91.223.45.108', 'IP_ADDRESS'],
    '\nZgoda marketingowa: TAK\nUwagi: proszę o kontakt dopiero po majówce.',
  ]),
];
