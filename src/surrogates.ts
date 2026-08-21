/**
 * @doccloak/core - realistic, shape-preserving surrogate generator (T043).
 *
 * Generates fake-but-plausible replacements for detected entities instead
 * of bracket placeholders: locale-aware names, dates shifted while keeping
 * their format, IBANs/phones/IDs that keep their shape (checksum-valid
 * where the checksum is cheap to compute).
 *
 * Determinism contract: every surrogate is a pure function of
 * (session salt, entity type, original value, attempt). No Math.random or
 * Date.now is ever consulted at module or generation scope, so the same
 * original always yields the same surrogate within a session and tests are
 * reproducible. The salt itself is created once per session (see
 * generateSessionSalt, called from the AnonymizationSession constructor)
 * and persisted with the map so a deserialized session keeps producing
 * consistent surrogates.
 *
 * Fake-identifier policy: we never deliberately generate a real person's
 * identifier. Generated PESELs encode a 19th-century birth date (a range
 * the registry never issued numbers for), generated SSN shapes use the
 * 900-999 area (never allocated by the SSA) with a group outside every
 * valid ITIN range (T101: a 9xx area alone could still form a real ITIN),
 * generated EIN shapes use campus prefixes the IRS has never assigned,
 * generated ABA routing shapes are checksum-valid but carry the 99 leading
 * pair (the ABA assigns only 00-12, 21-32, 61-72, and 80), generated NHS
 * numbers sit in the mod-11-valid 999 test range (never issued to
 * patients), and generated NINOs use the QQ prefix HMRC reserves for
 * documentation examples. Random collisions with real identifiers of other
 * kinds are statistically possible but not targetable: nothing about the
 * original value survives into the surrogate beyond its shape.
 */

import type { EntityType } from './types.ts';

// ── Deterministic hashing / PRNG ───────────────────────────

/** 32-bit FNV-1a over a UTF-16 string. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;

function rngFor(salt: string, ...parts: Array<string | number>): Rand {
  return mulberry32(fnv1a(`${salt}\u0000${parts.join('\u0000')}`));
}

function pick<T>(rand: Rand, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/** Integer in [min, max] inclusive. */
function randInt(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function randDigit(rand: Rand): string {
  return String(randInt(rand, 0, 9));
}

// ── Session salt ───────────────────────────────────────────

/**
 * One salt per session, created at session construction time (never at
 * module scope). WebCrypto when available; a constructor-time Math.random
 * fallback otherwise (the salt only needs to be unique-ish per session,
 * not cryptographically strong - surrogates are not secrets).
 */
export function generateSessionSalt(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// ── Name pools (EN + PL) ───────────────────────────────────

const EN_FIRST_MALE = [
  'James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph',
  'Thomas', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Steven', 'Paul',
  'Andrew', 'Joshua', 'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward',
  'Jason', 'Jeffrey', 'Ryan', 'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan',
  'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon', 'Benjamin', 'Samuel', 'Gregory',
] as const;

const EN_FIRST_FEMALE = [
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica',
  'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley',
  'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol', 'Amanda', 'Dorothy', 'Melissa',
  'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura', 'Cynthia', 'Kathleen', 'Amy',
  'Angela', 'Shirley', 'Anna', 'Ruth', 'Brenda', 'Pamela', 'Emma', 'Nicole',
] as const;

const EN_SURNAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee',
  'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Young',
  'Allen', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson',
  'Hill', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner',
] as const;

const PL_FIRST_MALE = [
  'Jan', 'Piotr', 'Krzysztof', 'Andrzej', 'Tomasz', 'Paweł', 'Michał', 'Marcin',
  'Marek', 'Grzegorz', 'Jerzy', 'Tadeusz', 'Adam', 'Łukasz', 'Zbigniew', 'Ryszard',
  'Dariusz', 'Henryk', 'Mariusz', 'Kazimierz', 'Wojciech', 'Robert', 'Mateusz', 'Marian',
  'Rafał', 'Jacek', 'Janusz', 'Mirosław', 'Maciej', 'Sławomir', 'Jarosław', 'Kamil',
  'Wiesław', 'Roman', 'Władysław', 'Jakub', 'Artur', 'Zdzisław', 'Edward', 'Dawid',
] as const;

const PL_FIRST_FEMALE = [
  'Anna', 'Maria', 'Katarzyna', 'Małgorzata', 'Agnieszka', 'Barbara', 'Krystyna', 'Ewa',
  'Elżbieta', 'Zofia', 'Janina', 'Teresa', 'Joanna', 'Magdalena', 'Monika', 'Jadwiga',
  'Danuta', 'Irena', 'Halina', 'Helena', 'Beata', 'Aleksandra', 'Marta', 'Dorota',
  'Marianna', 'Grażyna', 'Jolanta', 'Stanisława', 'Iwona', 'Karolina', 'Bożena', 'Urszula',
  'Justyna', 'Renata', 'Alicja', 'Paulina', 'Sylwia', 'Natalia', 'Wanda', 'Agata',
] as const;

/** Masculine base forms; feminizePlSurname derives -ska/-cka/-dzka endings. */
const PL_SURNAMES = [
  'Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamiński', 'Lewandowski', 'Zieliński',
  'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowski', 'Jankowski', 'Mazur', 'Kwiatkowski', 'Krawczyk',
  'Piotrowski', 'Grabowski', 'Nowakowski', 'Pawłowski', 'Michalski', 'Nowicki', 'Adamczyk', 'Dudek',
  'Zając', 'Wieczorek', 'Jabłoński', 'Król', 'Majewski', 'Olszewski', 'Jaworski', 'Wróbel',
  'Malinowski', 'Pawlak', 'Witkowski', 'Walczak', 'Stępień', 'Górski', 'Rutkowski', 'Michalak',
] as const;

function feminizePlSurname(surname: string): string {
  if (surname.endsWith('dzki')) return surname.slice(0, -1) + 'a';
  if (surname.endsWith('cki')) return surname.slice(0, -1) + 'a';
  if (surname.endsWith('ski')) return surname.slice(0, -1) + 'a';
  return surname; // invariant surnames (Nowak, Mazur, ...)
}

// ── Locale packs beyond EN/PL (T073) ───────────────────────
//
// Detection covers 24 EU languages (BardS.ai); generation must not hand
// a German document an English fake name. Each pack carries the data one
// language needs; adding a locale is adding data, not code. Pools are
// deliberately modest (16-24 entries): variety within one session is
// guaranteed by collision handling, not pool size.

const DE_FIRST_MALE = [
  'Hans', 'Peter', 'Michael', 'Thomas', 'Andreas', 'Wolfgang', 'Klaus', 'Jürgen',
  'Stefan', 'Christian', 'Markus', 'Alexander', 'Frank', 'Uwe', 'Martin', 'Werner',
  'Matthias', 'Bernd', 'Florian', 'Tobias', 'Sebastian', 'Lukas', 'Felix', 'Jonas',
] as const;

const DE_FIRST_FEMALE = [
  'Ursula', 'Monika', 'Petra', 'Sabine', 'Renate', 'Helga', 'Karin', 'Brigitte',
  'Andrea', 'Claudia', 'Susanne', 'Julia', 'Katrin', 'Anja', 'Nicole', 'Stefanie',
  'Christina', 'Birgit', 'Heike', 'Lena', 'Hannah', 'Laura', 'Lisa', 'Sophie',
] as const;

const DE_SURNAMES = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker',
  'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf',
  'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann', 'Lange',
] as const;

const FR_FIRST_MALE = [
  'Jean', 'Pierre', 'Michel', 'Philippe', 'Alain', 'Bernard', 'Christophe', 'Nicolas',
  'François', 'Laurent', 'Éric', 'Julien', 'Olivier', 'Thierry', 'Antoine', 'Mathieu',
  'Sébastien', 'Vincent', 'Guillaume', 'Hugo', 'Louis', 'Lucas', 'Thomas', 'Paul',
] as const;

const FR_FIRST_FEMALE = [
  'Marie', 'Nathalie', 'Isabelle', 'Sylvie', 'Catherine', 'Françoise', 'Christine', 'Monique',
  'Sophie', 'Céline', 'Julie', 'Aurélie', 'Camille', 'Léa', 'Chloé', 'Manon',
  'Élise', 'Charlotte', 'Emma', 'Louise', 'Alice', 'Juliette', 'Margaux', 'Inès',
] as const;

const FR_SURNAMES = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand',
  'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David',
  'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Morel', 'Girard', 'Lambert', 'Fontaine',
] as const;

const ES_FIRST_MALE = [
  'José', 'Antonio', 'Manuel', 'Francisco', 'Juan', 'David', 'Javier', 'Carlos',
  'Miguel', 'Rafael', 'Pedro', 'Ángel', 'Alejandro', 'Fernando', 'Sergio', 'Pablo',
  'Jorge', 'Alberto', 'Diego', 'Adrián', 'Raúl', 'Iván', 'Rubén', 'Óscar',
] as const;

const ES_FIRST_FEMALE = [
  'María', 'Carmen', 'Josefa', 'Isabel', 'Ana', 'Dolores', 'Pilar', 'Teresa',
  'Rosa', 'Cristina', 'Laura', 'Marta', 'Elena', 'Lucía', 'Sara', 'Paula',
  'Raquel', 'Beatriz', 'Silvia', 'Patricia', 'Nuria', 'Alba', 'Andrea', 'Irene',
] as const;

const ES_SURNAMES = [
  'García', 'Rodríguez', 'González', 'Fernández', 'López', 'Martínez', 'Sánchez', 'Pérez',
  'Gómez', 'Martín', 'Jiménez', 'Ruiz', 'Hernández', 'Díaz', 'Moreno', 'Muñoz',
  'Álvarez', 'Romero', 'Alonso', 'Gutiérrez', 'Navarro', 'Torres', 'Domínguez', 'Vázquez',
] as const;

const IT_FIRST_MALE = [
  'Giuseppe', 'Giovanni', 'Antonio', 'Mario', 'Luigi', 'Francesco', 'Angelo', 'Vincenzo',
  'Pietro', 'Salvatore', 'Carlo', 'Franco', 'Domenico', 'Bruno', 'Paolo', 'Michele',
  'Giorgio', 'Aldo', 'Sergio', 'Luciano', 'Marco', 'Alessandro', 'Andrea', 'Stefano',
] as const;

const IT_FIRST_FEMALE = [
  'Maria', 'Anna', 'Giuseppina', 'Rosa', 'Angela', 'Giovanna', 'Teresa', 'Lucia',
  'Carmela', 'Caterina', 'Francesca', 'Paola', 'Laura', 'Elena', 'Giulia', 'Chiara',
  'Sofia', 'Alessia', 'Martina', 'Valentina', 'Federica', 'Silvia', 'Elisa', 'Sara',
] as const;

const IT_SURNAMES = [
  'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci',
  'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'Vitale', 'Mancini', 'Costa',
  'Giordano', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani',
] as const;

/** Masculine base forms; feminizeCsSurname derives -ová / -á endings. */
const CS_FIRST_MALE = [
  'Jiří', 'Jan', 'Petr', 'Josef', 'Pavel', 'Martin', 'Tomáš', 'Jaroslav',
  'Miroslav', 'Zdeněk', 'František', 'Václav', 'Michal', 'Milan', 'Karel', 'Lukáš',
  'David', 'Ladislav', 'Stanislav', 'Roman', 'Ondřej', 'Jakub', 'Vladimír', 'Radek',
] as const;

const CS_FIRST_FEMALE = [
  'Marie', 'Jiřina', 'Anna', 'Věra', 'Alena', 'Lenka', 'Hana', 'Jaroslava',
  'Kateřina', 'Lucie', 'Eva', 'Jana', 'Petra', 'Martina', 'Zuzana', 'Michaela',
  'Tereza', 'Barbora', 'Veronika', 'Kristýna', 'Markéta', 'Ivana', 'Monika', 'Klára',
] as const;

const CS_SURNAMES = [
  'Novák', 'Svoboda', 'Novotný', 'Dvořák', 'Černý', 'Procházka', 'Kučera', 'Veselý',
  'Horák', 'Němec', 'Marek', 'Pokorný', 'Pospíšil', 'Hájek', 'Král', 'Jelínek',
  'Růžička', 'Beneš', 'Fiala', 'Sedláček', 'Doležal', 'Zeman', 'Kolář', 'Urban',
] as const;

function feminizeCsSurname(surname: string): string {
  if (surname.endsWith('ý')) return surname.slice(0, -1) + 'á';
  if (surname.endsWith('ová') || surname.endsWith('á')) return surname;
  return surname + 'ová';
}

/** Masculine base forms; feminizeUkSurname derives -ська/-цька endings. */
const UK_FIRST_MALE = [
  'Олександр', 'Сергій', 'Андрій', 'Володимир', 'Іван', 'Михайло', 'Віктор', 'Юрій',
  'Микола', 'Дмитро', 'Олег', 'Василь', 'Петро', 'Тарас', 'Богдан', 'Максим',
  'Павло', 'Роман', 'Ігор', 'Антон', 'Назар', 'Остап', 'Денис', 'Артем',
] as const;

const UK_FIRST_FEMALE = [
  'Олена', 'Тетяна', 'Наталія', 'Ірина', 'Оксана', 'Людмила', 'Світлана', 'Марія',
  'Ганна', 'Юлія', 'Катерина', 'Вікторія', 'Анастасія', 'Ольга', 'Соломія', 'Дарина',
  'Христина', 'Софія', 'Леся', 'Надія', 'Галина', 'Зоряна', 'Мирослава', 'Лілія',
] as const;

const UK_SURNAMES = [
  'Шевченко', 'Бондаренко', 'Коваленко', 'Ткаченко', 'Кравченко', 'Олійник', 'Мельник', 'Поліщук',
  'Бойко', 'Ковальчук', 'Лисенко', 'Савченко', 'Руденко', 'Марченко', 'Петренко', 'Козак',
  'Мороз', 'Гончаренко', 'Левченко', 'Василенко', 'Кушнір', 'Романюк', 'Гаврилюк', 'Заєць',
] as const;

const NL_FIRST_MALE = [
  'Daan', 'Sem', 'Bram', 'Lars', 'Thijs', 'Ruben', 'Kees', 'Joost',
  'Maarten', 'Wouter', 'Jeroen', 'Sander', 'Bas', 'Niels', 'Floris', 'Gerrit',
  'Pieter', 'Willem', 'Hendrik', 'Cornelis', 'Dirk', 'Jaap', 'Sjoerd', 'Teun',
] as const;

const NL_FIRST_FEMALE = [
  'Sanne', 'Lotte', 'Femke', 'Anouk', 'Fleur', 'Iris', 'Nienke', 'Marloes',
  'Ilse', 'Esmee', 'Roos', 'Lieke', 'Johanna', 'Cornelia', 'Willemien', 'Truus',
  'Marijke', 'Annemiek', 'Wilma', 'Jantine', 'Gerda', 'Hanneke', 'Mieke', 'Els',
] as const;

/** Single-token forms only: multi-token surnames (van der ...) would
 *  break the token-count preservation guarantee of generatePerson. */
const NL_SURNAMES = [
  'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer', 'Mulder', 'Bos', 'Vos',
  'Peters', 'Hendriks', 'Dekker', 'Brouwer', 'Dijkstra', 'Smits', 'Kuipers', 'Post',
  'Kok', 'Verhoeven', 'Willems', 'Maas', 'Hermans', 'Timmermans', 'Schouten', 'Jacobs',
] as const;

const PT_FIRST_MALE = [
  'Jo\u00e3o', 'Lu\u00eds', 'Paulo', 'Rui', 'Nuno', 'Tiago', 'Ricardo', 'Andr\u00e9',
  'Diogo', 'Gon\u00e7alo', 'Vasco', 'Duarte', 'Afonso', 'Bernardo', 'Rodrigo', 'Ant\u00f3nio',
  'Manuel', 'Francisco', 'Carlos', 'Pedro', 'Miguel', 'Jos\u00e9', 'Henrique', 'Sim\u00e3o',
] as const;

const PT_FIRST_FEMALE = [
  'Catarina', 'Margarida', 'Mariana', 'Joana', 'Rita', 'Carolina', 'Leonor', 'Matilde',
  'Francisca', 'Madalena', 'Const\u00e2ncia', 'Louren\u00e7a', 'Gra\u00e7a', 'Concei\u00e7\u00e3o', 'Lurdes', 'In\u00eas',
  'Beatriz', 'Isabel', 'Teresa', 'Sofia', 'Ana', 'Maria', 'Manuela', 'Fernanda',
] as const;

const PT_SURNAMES = [
  'Silva', 'Santos', 'Ferreira', 'Pereira', 'Oliveira', 'Rodrigues', 'Martins', 'Sousa',
  'Fernandes', 'Gon\u00e7alves', 'Gomes', 'Lopes', 'Marques', 'Alves', 'Almeida', 'Ribeiro',
  'Pinto', 'Carvalho', 'Teixeira', 'Moreira', 'Correia', 'Mendes', 'Nunes', 'Coelho',
] as const;

function feminizeUkSurname(surname: string): string {
  if (surname.endsWith('ський') || surname.endsWith('цький')) {
    return surname.slice(0, -2) + 'а'; // -ський -> -ська, -цький -> -цька
  }
  return surname; // -енко/-ук/-як and similar are invariant
}

const SV_FIRST_MALE = [
  'Erik', 'Lars', 'Karl', 'Anders', 'Johan', 'Per', 'Nils', 'Sven',
  'Gunnar', 'Bo', '\u00c5ke', 'G\u00f6ran', 'Henrik', 'Magnus', 'Fredrik', 'Oskar',
] as const;

const SV_FIRST_FEMALE = [
  'Anna', 'Eva', 'Maria', 'Karin', 'Ingrid', 'Kerstin', 'Lena', 'Helena',
  'Marianne', 'Birgitta', 'Elin', 'Sara', 'Emma', 'Linnea', 'Astrid', 'Ebba',
] as const;

const SV_SURNAMES = [
  'Andersson', 'Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson', 'Olsson', 'Persson',
  'Svensson', 'Gustafsson', 'Pettersson', 'Jonsson', 'Lindberg', 'Lindqvist', 'Bergstr\u00f6m', 'Sandberg',
] as const;

const NO_FIRST_MALE = [
  'Ole', 'Lars', 'Knut', 'Bj\u00f8rn', 'Arne', 'Odd', 'Geir', 'Tor',
  'Terje', 'Kjell', 'Espen', 'H\u00e5kon', 'Sindre', 'Eirik', 'Trygve', 'Leif',
] as const;

const NO_FIRST_FEMALE = [
  'Anne', 'Inger', 'Kari', 'Marit', 'Ingrid', 'Liv', 'Astrid', 'Solveig',
  'Randi', 'Bj\u00f8rg', 'Silje', 'Mari', 'Ingeborg', 'Tone', 'Gunn', 'Sigrid',
] as const;

const NO_SURNAMES = [
  'Hansen', 'Johansen', 'Olsen', 'Larsen', 'Andersen', 'Pedersen', 'Nilsen', 'Kristiansen',
  'Jensen', 'Karlsen', 'Berg', 'Haugen', 'Hagen', 'Solberg', 'Moen', 'Lien',
] as const;

const DA_FIRST_MALE = [
  'Jens', 'Peter', 'Lars', 'Henrik', 'S\u00f8ren', 'Niels', 'Ole', 'Erik',
  'Mads', 'Rasmus', 'Bent', 'Kaj', 'Frederik', 'Mikkel', 'Emil', 'Bjarne',
] as const;

const DA_FIRST_FEMALE = [
  'Kirsten', 'Mette', 'Hanne', 'Lone', 'Bente', 'Karen', 'Dorthe', 'Pia',
  'Gitte', 'Ditte', 'Freja', 'Signe', 'Maja', 'Cecilie', 'Louise', 'Astrid',
] as const;

const DA_SURNAMES = [
  'Nielsen', 'Jensen', 'Hansen', 'Pedersen', 'Andersen', 'Christensen', 'Larsen', 'S\u00f8rensen',
  'Rasmussen', 'J\u00f8rgensen', 'Petersen', 'Madsen', 'Kristensen', 'Olsen', 'Thomsen', 'Poulsen',
] as const;

const FI_FIRST_MALE = [
  'Juha', 'Matti', 'Pekka', 'Timo', 'Jari', 'Antti', 'Mikko', 'Kari',
  'Heikki', 'Ville', 'Janne', 'Sami', 'Jussi', 'Eero', 'Olli', 'Tapio',
] as const;

const FI_FIRST_FEMALE = [
  'Tiina', 'Sanna', 'Anne', 'P\u00e4ivi', 'Ritva', 'Leena', 'Maarit', 'Hanna',
  'Laura', 'Elina', 'Kaisa', 'Aino', 'Helmi', 'Sofia', 'Emmi', 'Noora',
] as const;

const FI_SURNAMES = [
  'Korhonen', 'Virtanen', 'M\u00e4kinen', 'Nieminen', 'M\u00e4kel\u00e4', 'H\u00e4m\u00e4l\u00e4inen', 'Laine', 'Heikkinen',
  'Koskinen', 'J\u00e4rvinen', 'Lehtonen', 'Lehtinen', 'Saarinen', 'Salminen', 'Heinonen', 'Niemi',
] as const;

/** CJK pools: full-name composition differs (surname first, no space). */
const JA_SURNAMES = [
  '\u7530\u4e2d', '\u4f50\u85e4', '\u9234\u6728', '\u9ad8\u6a4b', '\u4f0a\u85e4', '\u6e21\u8fba', '\u5c71\u672c', '\u4e2d\u6751',
  '\u5c0f\u6797', '\u52a0\u85e4', '\u5409\u7530', '\u5c71\u7530', '\u677e\u672c', '\u4e95\u4e0a', '\u6728\u6751', '\u6e05\u6c34',
] as const;

const JA_GIVEN_MALE = [
  '\u592a\u90ce', '\u5065\u4e00', '\u8aa0', '\u6d69', '\u9686', '\u5b66', '\u4fee', '\u5927\u8f14',
  '\u76f4\u6a39', '\u5065\u592a', '\u7fd4\u592a', '\u62d3\u54c9', '\u96c4\u4ecb', '\u5eb7\u5e73', '\u6b63\u6a39', '\u548c\u5f66',
] as const;

const JA_GIVEN_FEMALE = [
  '\u82b1\u5b50', '\u7f8e\u54b2', '\u967d\u5b50', '\u6075\u5b50', '\u7531\u7f8e', '\u611b', '\u821e', '\u5343\u5c0b',
  '\u7d50\u8863', '\u3055\u304f\u3089', '\u7f8e\u7a42', '\u771f\u7531', '\u5f69\u82b1', '\u679c\u6b69', '\u512a\u5b50', '\u660e\u65e5\u9999',
] as const;

const ZH_SURNAMES = [
  '\u738b', '\u674e', '\u5f20', '\u5218', '\u9648', '\u6768', '\u9ec4', '\u8d75',
  '\u5468', '\u5434', '\u5f90', '\u5b59', '\u9a6c', '\u6731', '\u80e1', '\u90ed',
] as const;

const ZH_GIVEN_MALE = [
  '\u4f1f', '\u5f3a', '\u78ca', '\u519b', '\u52c7', '\u6770', '\u6d9b', '\u660e',
  '\u8d85', '\u9e4f', '\u5efa\u534e', '\u6587\u8f89', '\u5fd7\u5f3a', '\u6d77\u6d0b', '\u5b87\u8ed2', '\u6653\u4e1c',
] as const;

const ZH_GIVEN_FEMALE = [
  '\u82b3', '\u5a1c', '\u654f', '\u9759', '\u4e3d', '\u8273', '\u971e', '\u71d5',
  '\u79c0\u82f1', '\u6842\u82f1', '\u96e8\u6674', '\u6021\u7136', '\u6b23\u6021', '\u4f73\u7434', '\u6653\u6885', '\u5a77\u5a77',
] as const;

// ── Other pools ────────────────────────────────────────────

/** Reserved/example domains only (RFC 2606 / RFC 6761): never routable. */
export const FAKE_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'mail.example',
  'post.example', 'inbox.test', 'mail.test', 'poczta.test',
] as const;

const EN_STREETS = [
  'Maple', 'Oak', 'Cedar', 'Elm', 'Willow', 'Chestnut', 'Birch', 'Highland',
  'Lakeview', 'Hillcrest', 'Riverside', 'Sunset', 'Meadow', 'Orchard', 'Garden', 'Prospect',
] as const;

const PL_STREETS = [
  'Polna', 'Leśna', 'Słoneczna', 'Krótka', 'Szkolna', 'Ogrodowa', 'Lipowa', 'Brzozowa',
  'Kwiatowa', 'Sosnowa', 'Łąkowa', 'Akacjowa', 'Spacerowa', 'Parkowa', 'Zielona', 'Wiosenna',
] as const;

const EN_COMPANIES = [
  'Northbridge Solutions', 'Bluepine Systems', 'Graystone Consulting', 'Silverleaf Media',
  'Ironwood Logistics', 'Brightharbor Labs', 'Stonegate Partners', 'Clearwater Dynamics',
  'Redfern Ventures', 'Copperfield Trading', 'Summitline Software', 'Harborview Analytics',
  'Oakfield Services', 'Westgate Supplies', 'Pinecrest Manufacturing', 'Lakeshore Digital',
] as const;

const PL_COMPANIES = [
  'Polbud', 'Stalmex', 'Drewpol', 'Budomax', 'Agropol', 'Techmet', 'Instalex', 'Metalpol',
  'Transwex', 'Elektrobud', 'Chemipol', 'Dombex', 'Hydromax', 'Termopol', 'Mebloplast', 'Kablomex',
] as const;

const COMPANY_SUFFIXES = [
  'Sp. z o.o.', 'sp. z o.o.', 'S.A.', 'sp.j.', 'sp. j.', 'GmbH & Co. KG', 'GmbH', 'AG',
  'Ltd.', 'Ltd', 'LLC', 'Inc.', 'Inc', 'B.V.', 'S.à r.l.', 'SARL', 'SAS', 'AB', 'Oy',
  'S.r.l.', 'S.p.A.', 'S.L.', 'S.L.U.', 's.r.o.', 'a.s.', 'ТОВ', 'ПрАТ',
  'N.V.', 'Unipessoal Lda.', 'Lda.', 'Lda',
  'ApS', 'A/S', 'AS', 'ASA', 'Oyj', '\u682a\u5f0f\u4f1a\u793e', '\u6709\u9650\u516c\u53f8',
] as const;

// T073 street pools; each locale's formatAddress composes them below.
const DE_STREETS = [
  'Linden', 'Garten', 'Berg', 'Wald', 'Schul', 'Haupt', 'Birken', 'Rosen',
  'Feld', 'Wiesen', 'Mühlen', 'Kirch', 'Bahnhof', 'Ahorn', 'Buchen', 'Tannen',
] as const;

const FR_STREETS = [
  'des Lilas', 'des Érables', 'de la Gare', 'du Moulin', 'des Peupliers', 'de la Fontaine',
  'des Tilleuls', 'du Château', 'des Acacias', 'de la Mairie', 'des Cerisiers', 'du Stade',
] as const;

const ES_STREETS = [
  'del Sol', 'de la Luna', 'del Prado', 'de los Olivos', 'del Pinar', 'de la Fuente',
  'de las Flores', 'del Rosal', 'de la Sierra', 'de los Almendros', 'del Parque', 'de la Vega',
] as const;

const IT_STREETS = [
  'dei Tigli', 'delle Rose', 'dei Pini', 'del Sole', 'delle Querce', 'dei Gelsomini',
  'della Fontana', 'dei Ciliegi', 'del Bosco', 'delle Viole', 'degli Ulivi', 'del Parco',
] as const;

const CS_STREETS = [
  'Polní', 'Zahradní', 'Krátká', 'Školní', 'Lipová', 'Květinová', 'Luční', 'Lesní',
  'Slunečná', 'Březová', 'Jasmínová', 'Růžová', 'Nádražní', 'Sportovní', 'Okružní', 'Havlíčkova',
] as const;

const UK_STREETS = [
  'Зелена', 'Садова', 'Шкільна', 'Польова', 'Лісова', 'Квіткова', 'Сонячна', 'Вишнева',
  'Калинова', 'Озерна', 'Джерельна', 'Ярова', 'Липова', 'Вербова', 'Степова', 'Затишна',
] as const;

const NL_STREETS = [
  'Kerk', 'School', 'Molen', 'Dorps', 'Beuken', 'Wilgen', 'Tulpen', 'Eiken',
  'Berken', 'Meidoorn', 'Zonnebloem', 'Sparren', 'Populieren', 'Kastanje', 'Rozen', 'Iepen',
] as const;

const PT_STREETS = [
  'das Flores', 'do Sol', 'da Paz', 'dos Pinheiros', 'das Oliveiras', 'da Fonte',
  'do Campo', 'das Amendoeiras', 'do Moinho', 'da Liberdade', 'das Ac\u00e1cias', 'dos Salgueiros',
] as const;

const DE_COMPANIES = [
  'Nordbau Technik', 'Rheinwerk Systeme', 'Waldhof Logistik', 'Steinbach Metall',
  'Bergland Elektro', 'Hansewerk Handel', 'Talblick Software', 'Eichenhof Bau',
] as const;

const FR_COMPANIES = [
  'Techni Sud', 'Batim Ouest', 'Loginor', 'Métalfrance', 'Sologis', 'Verdalis',
  'Clermontech', 'Rivelec',
] as const;

const ES_COMPANIES = [
  'Construcciones Levante', 'Ibertec Soluciones', 'Logística Meridional', 'Metalúrgica Norte',
  'Electrosur', 'Grupo Almenara', 'Tecnovega', 'Riberalia',
] as const;

const IT_COMPANIES = [
  'Tecnitalia', 'Costruzioni Adriatica', 'Logistica Padana', 'Metallurgica Verde',
  'Elettrosud', 'Gruppo Collina', 'Softogna', 'Riviera Impianti',
] as const;

const CS_COMPANIES = [
  'Stavomont', 'Kovodílo', 'Elektroservis Morava', 'Dřevostav', 'Logistika Vltava',
  'Technoplast', 'Montáže Sever', 'Agroslužby Haná',
] as const;

const UK_COMPANIES = [
  'Будсервіс', 'Агротехніка', 'Металінвест', 'Електропостач', 'Логістик Захід',
  'Технопривід', 'Деревобуд', 'Енергоресурс',
] as const;

const SV_STREETS = [
  'Bj\u00f6rk', 'Ek', 'Lind', 'Ros', 'Kyrko', 'Skol', 'Strand', '\u00c4ngs',
  'Berg', 'Sj\u00f6', 'Furu', 'Aspen',
] as const;

const NO_STREETS = [
  'Bj\u00f8rke', 'Eike', 'Kirke', 'Skole', 'Strand', 'Fjell', 'Elve', 'Gran',
  'Furubakk', 'Solbakk', 'Ljabru', 'Bekke',
] as const;

const DA_STREETS = [
  'Birke', 'Ege', 'Kirke', 'Skole', 'Strand', 'M\u00f8lle', 'Ro', 'Sol',
  'S\u00f8nder', 'N\u00f8rre', '\u00d8ster', 'Vester',
] as const;

const FI_STREETS = [
  'Koivu', 'Tammi', 'Kirkko', 'Koulu', 'Ranta', 'M\u00e4ki', 'J\u00e4rvi', 'Kuusi',
  'Honka', 'Niitty', 'Pelto', 'Vaahtera',
] as const;

const JA_STREETS = [
  '\u685c', '\u7dd1', '\u672c', '\u65ed', '\u82e5\u8449', '\u6804', '\u5e73\u548c', '\u661f',
] as const;

const ZH_STREETS = [
  '\u548c\u5e73\u8def', '\u89e3\u653e\u8def', '\u4eba\u6c11\u8def', '\u4e2d\u5c71\u8def', '\u5efa\u8bbe\u8def', '\u5149\u660e\u8def', '\u6587\u5316\u8def', '\u80dc\u5229\u8def',
] as const;

const SV_COMPANIES = [
  'Nordstr\u00f6m Bygg', 'Sj\u00f6berg Teknik', 'Dalaverken', 'Lindqvist Handel',
  'Berglund Logistik', 'Svea Konsult', 'Kustdata', 'Fj\u00e4llverk',
] as const;

const NO_COMPANIES = [
  'Fjordbygg', 'Nordkraft Teknikk', 'Vestlandslogistikk', 'Bergheim Handel',
  'Polardata', 'Kystverk Consult', 'Solli Entrepren\u00f8r', 'Elvestad Maskin',
] as const;

const DA_COMPANIES = [
  'Nordjysk Byg', 'Baltika Handel', '\u00d8resund Teknik', 'Danlogistik',
  'K\u00f8benhavns Maskinv\u00e6rk', 'Vestkyst Data', 'Gr\u00f8nvang Consult', 'Midtjysk Montage',
] as const;

const FI_COMPANIES = [
  'Pohjolan Rakennus', 'J\u00e4rvitekniikka', 'Suomen Logistiikka', 'Kalustemesta',
  'Datapaja', 'Konepaja Kaiku', 'Mets\u00e4palvelu Honka', 'Lakeuden S\u00e4hk\u00f6',
] as const;

const JA_COMPANIES = [
  '\u7530\u4e2d\u5546\u4e8b', '\u5c71\u672c\u5de5\u696d', '\u4f50\u85e4\u7269\u7523', '\u9234\u6728\u96fb\u6a5f',
  '\u4e2d\u6751\u5efa\u8a2d', '\u5927\u548c\u6280\u7814', '\u65ed\u901a\u5546', '\u685c\u88fd\u4f5c\u6240',
] as const;

const ZH_COMPANIES = [
  '\u534e\u4fe1\u79d1\u6280', '\u5b8f\u8fbe\u8d38\u6613', '\u91d1\u6865\u5efa\u8bbe', '\u84dd\u5929\u7269\u6d41',
  '\u4e1c\u65b9\u7535\u5b50', '\u65b0\u661f\u5b9e\u4e1a', '\u957f\u6cb0\u673a\u68b0', '\u6cf0\u5b89\u5b9e\u4e1a',
] as const;

const NL_COMPANIES = [
  'Noordbouw', 'Rijnstaal', 'Deltatech', 'Havenlogistiek', 'Polderland Handel',
  'Wielingen Installaties', 'Maasstad Software', 'Duinzicht Advies',
] as const;

const PT_COMPANIES = [
  'Tecnolusa', 'Construtora Atl\u00e2ntico', 'Metalomec\u00e2nica Douro', 'Log\u00edstica Tejo',
  'Ib\u00e9rica Montagens', 'Transportes Minho', 'Enerlis', 'Vidral\u00e2ndia',
] as const;

// ── Locale / shape helpers ─────────────────────────────────

const PL_CHARS_RE = /[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c\u0104\u0106\u0118\u0141\u0143\u00d3\u015a\u0179\u017b]/;

function foldDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l')
    .replace(/\u0141/g, 'L')
    .replace(/\u00df/g, 'ss')
    .replace(/\u0153/g, 'oe')
    .replace(/\u0152/g, 'Oe');
}

type Gender = 'f' | 'm';

/**
 * Everything one language needs for locale-faithful surrogates (T073).
 * Adding a locale is adding one of these to LOCALE_PACKS - no new code.
 */
interface LocalePack {
  id: string;
  firstMale: readonly string[];
  firstFemale: readonly string[];
  surnames: readonly string[];
  /** Derive the female surname form; identity for invariant systems. */
  feminizeSurname?: (surname: string) => string;
  /** Characters DISTINCTIVE for this locale (drives person detection). */
  chars?: RegExp;
  /** Folded surname endings characteristic for this locale. */
  surnameEndings?: RegExp;
  /** UNFOLDED female surname endings (gender signal). */
  femaleSurnameEndings?: RegExp;
  /** UNFOLDED male surname endings (gender signal). */
  maleSurnameEndings?: RegExp;
  /** Female given names practically always end in -a (Slavic, ES/IT). */
  aEndsFemale?: boolean;
  /** Address keyword (ul./rue/calle/strasse...) for ADDRESS detection. */
  addressHint?: RegExp;
  streets?: readonly string[];
  formatAddress?: (street: string, n: number) => string;
  companies?: readonly string[];
  /** Legal-form suffixes that mark a company as this locale's. */
  companySuffixHint?: RegExp;
  /**
   * Full-name composer override (T073 CJK): languages whose names are
   * not space-separated first+surname build the whole surrogate here.
   */
  formatPerson?: (original: string, rand: Rand) => string;
  /** Surname prefixes for detection scoring (CJK: surname comes first;
   *  longer prefixes score higher, so 2-char JA beats 1-char ZH). */
  surnamePrefixes?: readonly string[];
  /** Script range claiming otherwise-unmatched values (Han -> zh). */
  scriptFallback?: RegExp;
}

const LOCALE_PACKS: readonly LocalePack[] = [
  {
    id: 'pl',
    firstMale: PL_FIRST_MALE,
    firstFemale: PL_FIRST_FEMALE,
    surnames: PL_SURNAMES,
    feminizeSurname: feminizePlSurname,
    chars: PL_CHARS_RE,
    surnameEndings: /(?:ski|ska|cki|cka|dzki|dzka|wicz|czyk|szek|owski|ewski)$/,
    femaleSurnameEndings: /(?:ska|cka|dzka)$/,
    maleSurnameEndings: /(?:ski|cki|dzki)$/,
    aEndsFemale: true,
    addressHint: /\b(?:ul|al|os|pl)\.\s/i,
    streets: PL_STREETS,
    formatAddress: (s, n) => `ul. ${s} ${n}`,
    companies: PL_COMPANIES,
    companySuffixHint: /z o\.o\.|S\.A\.|sp\. ?j\./i,
  },
  {
    id: 'uk',
    firstMale: UK_FIRST_MALE,
    firstFemale: UK_FIRST_FEMALE,
    surnames: UK_SURNAMES,
    feminizeSurname: feminizeUkSurname,
    // Cyrillic script is decisive on its own (uk is our Cyrillic pack).
    chars: /[\u0400-\u04ff]/,
    femaleSurnameEndings: /(?:\u0441\u044c\u043a\u0430|\u0446\u044c\u043a\u0430)$/,
    maleSurnameEndings: /(?:\u0441\u044c\u043a\u0438\u0439|\u0446\u044c\u043a\u0438\u0439)$/,
    aEndsFemale: true,
    addressHint: /\u0432\u0443\u043b\.?\s/i,
    streets: UK_STREETS,
    formatAddress: (s, n) => `\u0432\u0443\u043b. ${s} ${n}`,
    companies: UK_COMPANIES,
    companySuffixHint: /\u0422\u041e\u0412|\u041f\u0440\u0410\u0422/,
  },
  {
    id: 'cs',
    firstMale: CS_FIRST_MALE,
    firstFemale: CS_FIRST_FEMALE,
    surnames: CS_SURNAMES,
    feminizeSurname: feminizeCsSurname,
    chars: /[\u0159\u011b\u016f\u0165\u010f\u0148\u0158\u011a\u016e\u0164\u010e\u0147]/,
    surnameEndings: /(?:ova|acek|icek|ansky|ensky)$/,
    femaleSurnameEndings: /ov\u00e1$/,
    aEndsFemale: true,
    streets: CS_STREETS,
    formatAddress: (s, n) => `${s} ${n}`,
    companies: CS_COMPANIES,
    companySuffixHint: /s\.r\.o\.|a\.s\./i,
  },
  {
    id: 'de',
    firstMale: DE_FIRST_MALE,
    firstFemale: DE_FIRST_FEMALE,
    surnames: DE_SURNAMES,
    chars: /\u00df/,
    addressHint: /stra(?:\u00df|ss)e|\bweg\b|\bgasse\b/i,
    streets: DE_STREETS,
    formatAddress: (s, n) => `${s}stra\u00dfe ${n}`,
    companies: DE_COMPANIES,
    companySuffixHint: /GmbH|\bAG$/,
  },
  {
    id: 'es',
    firstMale: ES_FIRST_MALE,
    firstFemale: ES_FIRST_FEMALE,
    surnames: ES_SURNAMES,
    chars: /[\u00f1\u00d1\u00a1\u00bf]/,
    aEndsFemale: true,
    addressHint: /\b(?:calle|avenida|avda|plaza)\b/i,
    streets: ES_STREETS,
    formatAddress: (s, n) => `Calle ${s} ${n}`,
    companies: ES_COMPANIES,
    companySuffixHint: /S\.L\.U?\.?$/,
  },
  {
    id: 'fr',
    firstMale: FR_FIRST_MALE,
    firstFemale: FR_FIRST_FEMALE,
    surnames: FR_SURNAMES,
    chars: /[\u0153\u0152]/,
    addressHint: /\b(?:rue|avenue|boulevard|impasse)\b/i,
    streets: FR_STREETS,
    formatAddress: (s, n) => `${n} rue ${s}`,
    companies: FR_COMPANIES,
    companySuffixHint: /SARL|S\.\u00e0 r\.l\.|SAS$/,
  },
  {
    id: 'it',
    firstMale: IT_FIRST_MALE,
    firstFemale: IT_FIRST_FEMALE,
    surnames: IT_SURNAMES,
    aEndsFemale: true,
    addressHint: /\b(?:via|viale|piazza|corso)\b/i,
    streets: IT_STREETS,
    formatAddress: (s, n) => `Via ${s} ${n}`,
    companies: IT_COMPANIES,
    companySuffixHint: /S\.r\.l\.|S\.p\.A\./,
  },
  {
    id: 'pt',
    firstMale: PT_FIRST_MALE,
    firstFemale: PT_FIRST_FEMALE,
    surnames: PT_SURNAMES,
    chars: /[\u00e3\u00f5\u00c3\u00d5]/,
    aEndsFemale: true,
    addressHint: /\b(?:rua|travessa|pra\u00e7a|largo)\b/i,
    streets: PT_STREETS,
    formatAddress: (s, n) => `Rua ${s} ${n}`,
    companies: PT_COMPANIES,
    companySuffixHint: /Lda\.?$/,
  },
  {
    id: 'nl',
    firstMale: NL_FIRST_MALE,
    firstFemale: NL_FIRST_FEMALE,
    surnames: NL_SURNAMES,
    addressHint: /straat\b|\blaan\b|\bgracht\b|\bplein\b/i,
    streets: NL_STREETS,
    formatAddress: (s, n) => `${s}straat ${n}`,
    companies: NL_COMPANIES,
    companySuffixHint: /B\.V\.|N\.V\./,
  },
  {
    id: 'sv',
    firstMale: SV_FIRST_MALE,
    firstFemale: SV_FIRST_FEMALE,
    surnames: SV_SURNAMES,
    aEndsFemale: true,
    addressHint: /(?:v\u00e4gen|gatan)\b/i,
    streets: SV_STREETS,
    formatAddress: (s, n) => `${s}v\u00e4gen ${n}`,
    companies: SV_COMPANIES,
    companySuffixHint: /\bAB$/,
  },
  {
    id: 'no',
    firstMale: NO_FIRST_MALE,
    firstFemale: NO_FIRST_FEMALE,
    surnames: NO_SURNAMES,
    addressHint: /(?:veien|gata)\b/i,
    streets: NO_STREETS,
    formatAddress: (s, n) => `${s}veien ${n}`,
    companies: NO_COMPANIES,
    companySuffixHint: /\bASA$|\bAS$/,
  },
  {
    id: 'da',
    firstMale: DA_FIRST_MALE,
    firstFemale: DA_FIRST_FEMALE,
    surnames: DA_SURNAMES,
    addressHint: /(?:vej|gade)\b/i,
    streets: DA_STREETS,
    formatAddress: (s, n) => `${s}vej ${n}`,
    companies: DA_COMPANIES,
    companySuffixHint: /A\/S$|ApS$/,
  },
  {
    id: 'fi',
    firstMale: FI_FIRST_MALE,
    firstFemale: FI_FIRST_FEMALE,
    surnames: FI_SURNAMES,
    addressHint: /(?:katu|kuja)\b/i,
    streets: FI_STREETS,
    formatAddress: (s, n) => `${s}katu ${n}`,
    companies: FI_COMPANIES,
    companySuffixHint: /\bOyj?$/,
  },
  {
    id: 'ja',
    firstMale: JA_GIVEN_MALE,
    firstFemale: JA_GIVEN_FEMALE,
    surnames: JA_SURNAMES,
    // Kana is decisively Japanese; kanji-only names resolve via the
    // surname-prefix scoring below (2-char JA prefixes outscore 1-char
    // ZH ones) or the script fallback.
    chars: /[\u3040-\u30ff]/,
    surnamePrefixes: JA_SURNAMES,
    scriptFallback: /[\u3040-\u30ff]/,
    addressHint: /\u4e01\u76ee|\u756a\u5730/,
    streets: JA_STREETS,
    formatAddress: (s, n) => `${s}\u753a${n}\u4e01\u76ee`,
    companies: JA_COMPANIES,
    companySuffixHint: /\u682a\u5f0f\u4f1a\u793e/,
    formatPerson: (original, rand) => {
      const sep = original.includes('\u3000') ? '\u3000' : original.includes(' ') ? ' ' : '';
      const female = rand() < 0.5;
      const given = pick(rand, female ? JA_GIVEN_FEMALE : JA_GIVEN_MALE);
      return `${pick(rand, JA_SURNAMES)}${sep}${given}`;
    },
  },
  {
    id: 'zh',
    firstMale: ZH_GIVEN_MALE,
    firstFemale: ZH_GIVEN_FEMALE,
    surnames: ZH_SURNAMES,
    surnamePrefixes: ZH_SURNAMES,
    scriptFallback: /[\u4e00-\u9fff]/,
    addressHint: /[\u4e00-\u9fff]+\u8def|\u53f7$/,
    streets: ZH_STREETS,
    formatAddress: (s, n) => `${s}${n}\u53f7`,
    companies: ZH_COMPANIES,
    companySuffixHint: /\u6709\u9650\u516c\u53f8/,
    formatPerson: (original, rand) => {
      const female = rand() < 0.5;
      const rest = original.replace(/\s/g, '').length - 1;
      const pool = female ? ZH_GIVEN_FEMALE : ZH_GIVEN_MALE;
      const sized = pool.filter((g) => g.length === Math.max(1, Math.min(2, rest)));
      return `${pick(rand, ZH_SURNAMES)}${pick(rand, sized.length > 0 ? sized : pool)}`;
    },
  },
  {
    id: 'en',
    firstMale: EN_FIRST_MALE,
    firstFemale: EN_FIRST_FEMALE,
    surnames: EN_SURNAMES,
    streets: EN_STREETS,
    formatAddress: (s, n) => `${n} ${s} Street`,
    companies: EN_COMPANIES,
  },
] as const;

const EN_PACK = LOCALE_PACKS[LOCALE_PACKS.length - 1];

/** Folded lowercase name sets per pack, built once. */
const packNameSets = new Map<
  string,
  { female: Set<string>; male: Set<string>; all: Set<string>; surnames: Set<string> }
>();
for (const pack of LOCALE_PACKS) {
  const female = new Set(pack.firstFemale.map((n) => foldDiacritics(n).toLowerCase()));
  const male = new Set(pack.firstMale.map((n) => foldDiacritics(n).toLowerCase()));
  const surnames = new Set(
    pack.surnames.flatMap((n) => foldDiacritics(n).toLowerCase().split(/\s+/)),
  );
  packNameSets.set(pack.id, { female, male, all: new Set([...female, ...male]), surnames });
}

/**
 * Locale detection precedence: distinctive characters (script, or
 * diacritics unique enough to decide), then given-name pool membership,
 * then surname endings; EN is the fallback. Pack order in LOCALE_PACKS
 * is the tie-breaker for names shared between locales (Anna stays
 * Polish here, matching the pre-T073 behavior).
 */
function detectPersonPack(value: string): LocalePack {
  for (const pack of LOCALE_PACKS) {
    if (pack.chars?.test(value)) return pack;
  }
  // Names are shared between languages (Marie is French AND Czech), so
  // membership is SCORED per token across given-name and surname pools
  // plus characteristic surname endings; the best total wins and ties
  // keep the earlier pack (Anna stays Polish, pre-T073 behavior).
  const folded = value
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => foldDiacritics(t));
  let best: LocalePack | null = null;
  let bestScore = 0;
  for (const pack of LOCALE_PACKS) {
    const names = packNameSets.get(pack.id);
    if (!names) continue;
    let score = 0;
    for (const t of folded) {
      if (names.all.has(t) || names.surnames.has(t)) score += 1;
      else if (pack.surnameEndings?.test(t)) score += 1;
    }
    // CJK surname-first prefixes; longer prefixes score higher so a
    // 2-char Japanese surname outranks a 1-char Chinese one.
    if (pack.surnamePrefixes) {
      for (const prefix of pack.surnamePrefixes) {
        if (value.startsWith(prefix)) {
          score += prefix.length * 2;
          break;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = pack;
    }
  }
  if (best) return best;
  for (const pack of LOCALE_PACKS) {
    if (pack.scriptFallback?.test(value)) return pack;
  }
  return EN_PACK;
}

type CapsPattern = 'upper' | 'lower' | 'title';

function capsPatternOf(token: string): CapsPattern {
  if (/\p{L}/u.test(token)) {
    if (token === token.toUpperCase() && token !== token.toLowerCase()) return 'upper';
    if (token === token.toLowerCase()) return 'lower';
  }
  return 'title';
}

function applyCaps(word: string, pattern: CapsPattern): string {
  if (pattern === 'upper') return word.toUpperCase();
  if (pattern === 'lower') return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Same-shape substitution: digits become other digits, ASCII letters
 * become other letters of the same case; everything else (separators,
 * diacritics, symbols) is kept verbatim. The generic fallback.
 */
function sameShape(value: string, rand: Rand): string {
  let out = '';
  for (const ch of value) {
    if (ch >= '0' && ch <= '9') out += randDigit(rand);
    else if (ch >= 'a' && ch <= 'z') out += String.fromCharCode(97 + randInt(rand, 0, 25));
    else if (ch >= 'A' && ch <= 'Z') out += String.fromCharCode(65 + randInt(rand, 0, 25));
    else out += ch;
  }
  return out;
}

/** Digits-only substitution: keeps every non-digit (incl. letters) as-is. */
function sameShapeDigits(value: string, rand: Rand): string {
  return value.replace(/\d/g, () => randDigit(rand));
}

// ── PERSON ─────────────────────────────────────────────────

/**
 * Gender from the given name (pack pools first, then this pack's female
 * surname endings, then the Slavic/Romance -a heuristic where it holds).
 */
function detectGender(value: string, pack: LocalePack, rand: Rand): Gender {
  const tokens = value.split(/\s+/);
  const rawFirst = tokens[0] ?? '';
  const first = foldDiacritics(rawFirst).toLowerCase();
  const names = packNameSets.get(pack.id);
  if (names) {
    if (names.female.has(first)) return 'f';
    if (names.male.has(first)) return 'm';
  }
  const rawLast = tokens[tokens.length - 1] ?? '';
  if (pack.femaleSurnameEndings?.test(rawLast.toLowerCase())) return 'f';
  if (pack.maleSurnameEndings?.test(rawLast.toLowerCase())) return 'm';
  if (pack.aEndsFemale) {
    if (first.endsWith('a')) return 'f';
    if (first.length > 1) return 'm';
  }
  return rand() < 0.5 ? 'f' : 'm';
}

function surnameFor(pack: LocalePack, gender: Gender, rand: Rand): string {
  const base = pick(rand, pack.surnames);
  return gender === 'f' && pack.feminizeSurname ? pack.feminizeSurname(base) : base;
}

function firstNameFor(pack: LocalePack, gender: Gender, rand: Rand): string {
  return pick(rand, gender === 'f' ? pack.firstFemale : pack.firstMale);
}

/**
 * Token count and per-token capitalization are preserved: a two-token
 * name maps to first + surname, extra middle tokens become extra given
 * names, a hyphenated final token becomes a hyphenated double surname.
 */
function generatePerson(original: string, rand: Rand): string {
  const tokens = original.trim().split(/\s+/);
  if (tokens.length === 0 || original.trim() === '') return sameShape(original, rand);
  const pack = detectPersonPack(original);
  if (pack.formatPerson) return pack.formatPerson(original, rand);
  const gender = detectGender(original, pack, rand);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const caps = capsPatternOf(tokens[i]);
    const isLast = i === tokens.length - 1;
    let word: string;
    if (tokens.length === 1 || !isLast) {
      word = firstNameFor(pack, gender, rand);
    } else if (tokens[i].includes('-')) {
      const parts = tokens[i].split('-');
      word = parts.map(() => surnameFor(pack, gender, rand)).join('-');
    } else {
      word = surnameFor(pack, gender, rand);
    }
    out.push(caps === 'title' ? word : applyCaps(word, caps));
  }
  return out.join(' ');
}

// ── EMAIL ──────────────────────────────────────────────────

export interface SurrogateContext {
  /** Per-session salt; the sole source of randomness. */
  salt: string;
  /**
   * Already-issued session mappings, used to derive an email local part
   * from the surrogate of the matching PERSON (jan.kowalski maps to
   * adam.nowak style). Optional; without it emails get an unrelated
   * deterministic fake identity.
   */
  entries?: ReadonlyArray<{ original: string; replacement: string; entityType: EntityType }>;
}

/** A replacement usable as a name source: not a bracket/legacy token. */
function isNameLike(replacement: string): boolean {
  return !/[[\]<>]/.test(replacement) && /\p{L}/u.test(replacement);
}

function findMatchingPerson(
  local: string,
  entries: SurrogateContext['entries'],
): { original: string; replacement: string } | null {
  if (!entries) return null;
  const haystack = foldDiacritics(local).toLowerCase();
  for (const e of entries) {
    if (e.entityType !== 'PERSON' || !isNameLike(e.replacement)) continue;
    const tokens = foldDiacritics(e.original).toLowerCase().split(/[\s-]+/);
    if (tokens.some((t) => t.length >= 3 && haystack.includes(t))) {
      return { original: e.original, replacement: e.replacement };
    }
  }
  return null;
}

function generateEmail(original: string, ctx: SurrogateContext, rand: Rand): string {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(original);
  if (!m) return sameShape(original, rand);
  const [, local] = m;

  const digitsMatch = /^(.*?)(\d+)$/.exec(local);
  const localBase = digitsMatch ? digitsMatch[1] : local;
  const digitCount = digitsMatch ? digitsMatch[2].length : 0;

  const sep = ['.', '_', '-'].find((s) => localBase.includes(s)) ?? '';

  const person = findMatchingPerson(localBase, ctx.entries);
  let nameTokens: string[] | null = null;
  if (person) {
    const folded = foldDiacritics(person.replacement).toLowerCase().split(/[\s-]+/);
    // T073: a non-Latin surrogate name (Cyrillic) cannot form a sane
    // ASCII local part; fall through to the unrelated EN identity then.
    if (folded.every((t) => /^[a-z0-9]+$/.test(t))) nameTokens = folded;
  }
  if (!nameTokens) {
    // No in-session person to mirror: deterministic unrelated identity.
    nameTokens = [
      foldDiacritics(firstNameFor(EN_PACK, rand() < 0.5 ? 'f' : 'm', rand)).toLowerCase(),
      foldDiacritics(pick(rand, EN_SURNAMES)).toLowerCase(),
    ];
  }

  let newLocal: string;
  const origTokens = sep ? localBase.split(sep) : [localBase];
  if (sep && origTokens.length === nameTokens.length) {
    // Mirror the original pattern token by token; single-letter tokens
    // stay initials (j.kowalski maps to a.nowak).
    newLocal = origTokens
      .map((t, i) => (t.length === 1 ? nameTokens[i].charAt(0) : nameTokens[i]))
      .join(sep);
  } else {
    newLocal = nameTokens.join(sep || '.');
  }
  if (digitCount > 0) {
    let digits = '';
    for (let i = 0; i < digitCount; i++) digits += randDigit(rand);
    newLocal += digits;
  }

  const domain = pick(rand, FAKE_EMAIL_DOMAINS);
  return `${newLocal}@${domain}`;
}

// ── DATE ───────────────────────────────────────────────────

const EN_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
const EN_MONTHS_ABBR = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;
const PL_MONTHS_GEN = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
] as const;
const PL_MONTHS_NOM = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
] as const;
// T073 month names; genitive forms where dates inflect (cs, uk).
const DE_MONTHS = [
  'januar', 'februar', 'm\u00e4rz', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'dezember',
] as const;
const FR_MONTHS = [
  'janvier', 'f\u00e9vrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'ao\u00fbt', 'septembre', 'octobre', 'novembre', 'd\u00e9cembre',
] as const;
const ES_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;
const IT_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
] as const;
const CS_MONTHS_GEN = [
  'ledna', '\u00fanora', 'b\u0159ezna', 'dubna', 'kv\u011btna', '\u010dervna',
  '\u010dervence', 'srpna', 'z\u00e1\u0159\u00ed', '\u0159\u00edjna', 'listopadu', 'prosince',
] as const;
const UK_MONTHS_GEN = [
  '\u0441\u0456\u0447\u043d\u044f', '\u043b\u044e\u0442\u043e\u0433\u043e', '\u0431\u0435\u0440\u0435\u0437\u043d\u044f', '\u043a\u0432\u0456\u0442\u043d\u044f', '\u0442\u0440\u0430\u0432\u043d\u044f', '\u0447\u0435\u0440\u0432\u043d\u044f',
  '\u043b\u0438\u043f\u043d\u044f', '\u0441\u0435\u0440\u043f\u043d\u044f', '\u0432\u0435\u0440\u0435\u0441\u043d\u044f', '\u0436\u043e\u0432\u0442\u043d\u044f', '\u043b\u0438\u0441\u0442\u043e\u043f\u0430\u0434\u0430', '\u0433\u0440\u0443\u0434\u043d\u044f',
] as const;

const NL_MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
] as const;
const PT_MONTHS = [
  'janeiro', 'fevereiro', 'mar\u00e7o', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
] as const;

const SV_MONTHS = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
] as const;
const NO_MONTHS = [
  'januar', 'februar', 'mars', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'desember',
] as const;
const DA_MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
] as const;
/** Finnish dates use the partitive (15. maaliskuuta 2024). */
const FI_MONTHS_PART = [
  'tammikuuta', 'helmikuuta', 'maaliskuuta', 'huhtikuuta', 'toukokuuta', 'kes\u00e4kuuta',
  'hein\u00e4kuuta', 'elokuuta', 'syyskuuta', 'lokakuuta', 'marraskuuta', 'joulukuuta',
] as const;

const MONTH_LISTS: ReadonlyArray<readonly string[]> = [
  EN_MONTHS, EN_MONTHS_ABBR, PL_MONTHS_GEN, PL_MONTHS_NOM,
  DE_MONTHS, FR_MONTHS, ES_MONTHS, IT_MONTHS, CS_MONTHS_GEN, UK_MONTHS_GEN,
  NL_MONTHS, PT_MONTHS, SV_MONTHS, NO_MONTHS, DA_MONTHS, FI_MONTHS_PART,
];

function lookupMonth(token: string): { month: number; list: readonly string[] } | null {
  const lower = token.toLowerCase();
  for (const list of MONTH_LISTS) {
    const i = list.indexOf(lower);
    if (i !== -1) return { month: i + 1, list };
  }
  return null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

interface ParsedDate {
  y: number;
  m: number;
  d: number;
  rebuild: (y: number, m: number, d: number) => string;
}

function parseDate(value: string): ParsedDate | null {
  // CJK date (2024\u5e743\u670815\u65e5), shared by ja and zh.
  const cjk = /^(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5$/.exec(value);
  if (cjk) {
    return {
      y: +cjk[1], m: +cjk[2], d: +cjk[3],
      rebuild: (y, mo, d) => `${y}\u5e74${mo}\u6708${d}\u65e5`,
    };
  }
  let m = /^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (m) {
    const [, ys, sep, ms, ds] = m;
    return {
      y: +ys, m: +ms, d: +ds,
      rebuild: (y, mo, d) => `${y}${sep}${pad(mo, ms.length)}${sep}${pad(d, ds.length)}`,
    };
  }
  // Day-first (European) reading for D.M.YYYY / D/M/YYYY / D-M-YYYY.
  m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(value);
  if (m) {
    const [, ds, sep, ms, ys] = m;
    if (+ms >= 1 && +ms <= 12) {
      return {
        y: +ys, m: +ms, d: +ds,
        rebuild: (y, mo, d) => `${pad(d, ds.length)}${sep}${pad(mo, ms.length)}${sep}${y}`,
      };
    }
    return null;
  }
  // "15 March 2024" / "15 marca 2024"
  m = /^(\d{1,2})(\s+)(\p{L}+)(\s+)(\d{4})$/u.exec(value);
  if (m) {
    const [, ds, ws1, monthToken, ws2, ys] = m;
    const month = lookupMonth(monthToken);
    if (!month) return null;
    const caps = capsPatternOf(monthToken);
    return {
      y: +ys, m: month.month, d: +ds,
      rebuild: (y, mo, d) =>
        `${pad(d, ds.length)}${ws1}${applyCaps(month.list[mo - 1], caps)}${ws2}${y}`,
    };
  }
  // "March 15, 2024" / "March 15 2024"
  m = /^(\p{L}+)(\s+)(\d{1,2})(,?)(\s+)(\d{4})$/u.exec(value);
  if (m) {
    const [, monthToken, ws1, ds, comma, ws2, ys] = m;
    const month = lookupMonth(monthToken);
    if (!month) return null;
    const caps = capsPatternOf(monthToken);
    return {
      y: +ys, m: month.month, d: +ds,
      rebuild: (y, mo, d) =>
        `${applyCaps(month.list[mo - 1], caps)}${ws1}${pad(d, ds.length)}${comma}${ws2}${y}`,
    };
  }
  return null;
}

/**
 * Per-session day offset in [-30, -1] or [1, 30]: derived from the salt
 * only, so every date in a session shifts by the same amount and relative
 * spacing between dates is preserved. Never 0 (a zero shift would leak the
 * original date unchanged).
 */
export function sessionDayOffset(salt: string): number {
  const n = randInt(rngFor(salt, 'DATE_OFFSET'), 1, 60);
  return n <= 30 ? n : 30 - n;
}

function generateDate(original: string, ctx: SurrogateContext, rand: Rand, attempt: number): string {
  const parsed = parseDate(original.trim());
  if (parsed) {
    const { y, m, d } = parsed;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const ts = Date.UTC(y, m - 1, d);
      const check = new Date(ts);
      if (
        check.getUTCFullYear() === y &&
        check.getUTCMonth() === m - 1 &&
        check.getUTCDate() === d
      ) {
        const offset = sessionDayOffset(ctx.salt) + attempt;
        const shifted = new Date(ts + offset * 86400000);
        return parsed.rebuild(
          shifted.getUTCFullYear(),
          shifted.getUTCMonth() + 1,
          shifted.getUTCDate(),
        );
      }
    }
  }
  // Unparseable shapes keep their exact layout with substituted digits.
  return sameShapeDigits(original, rand);
}

// ── PHONE ──────────────────────────────────────────────────

/**
 * Formatting (spaces, dashes, parentheses) is kept verbatim; the
 * international prefix (+CC, 00CC, or a leading trunk 0) keeps its
 * digits and every subscriber digit is substituted.
 */
function generatePhone(original: string, rand: Rand): string {
  const trimmed = original.trim();
  let preserved: number;
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) preserved = Math.min(2, Math.max(0, digitsOnly.length - 4));
  else if (digitsOnly.startsWith('00')) preserved = Math.min(4, Math.max(0, digitsOnly.length - 4));
  else if (digitsOnly.startsWith('0')) preserved = 1;
  else preserved = 0;

  let seen = 0;
  return original.replace(/\d/g, (d) => {
    seen++;
    return seen <= preserved ? d : randDigit(rand);
  });
}

// ── IBAN ───────────────────────────────────────────────────

/** BBAN+check+country lengths for common IBAN countries. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AT: 20, BE: 16, BG: 22, CH: 21, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24,
  FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IT: 27, LT: 20,
  LU: 20, LV: 21, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24,
};

/** mod 97 over the alphanumeric IBAN expansion (A=10 .. Z=35). */
function ibanMod97(s: string): number {
  let rem = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem;
}

function generateIban(original: string, rand: Rand): string {
  const compact = original.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})\d{2}[A-Z0-9]+$/.exec(compact);
  if (!m) return sameShape(original, rand);
  const country = m[1];
  const length = IBAN_LENGTHS[country] ?? compact.length;
  const bbanLength = length - 4;

  // Mirror the original's letter/digit pattern positionally when lengths
  // match (keeps e.g. GB bank-code letters); otherwise all digits.
  let bban = '';
  for (let i = 0; i < bbanLength; i++) {
    const origCh = compact.length === length ? compact[4 + i] : '0';
    bban += origCh >= 'A' && origCh <= 'Z'
      ? String.fromCharCode(65 + randInt(rand, 0, 25))
      : randDigit(rand);
  }
  const check = String(98 - ibanMod97(`${bban}${country}00`)).padStart(2, '0');
  const generated = `${country}${check}${bban}`;

  // Reapply the original's grouping when the alnum counts line up.
  const origAlnum = original.replace(/\s/g, '').length;
  if (origAlnum === generated.length) {
    let i = 0;
    return original.replace(/[^\s]/g, () => generated[i++]);
  }
  return /\s/.test(original)
    ? generated.replace(/(.{4})(?=.)/g, '$1 ')
    : generated;
}

// ── National IDs (SSN entity type: PESEL, US SSN, ...) ─────

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const;

function peselChecksum(digits10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits10[i]) * PESEL_WEIGHTS[i];
  return (10 - (sum % 10)) % 10;
}

/**
 * Checksum-valid PESEL with a deliberate implausibility marker: the
 * encoded birth date lies in 1800-1899 (PESEL month field 81-92). The
 * registry has never issued numbers for people born in the 19th century,
 * so a generated value can never be a real living person's PESEL. We never
 * deliberately generate a real identifier; random collisions with other
 * identifier kinds are statistically possible but not targetable.
 */
function generatePesel(rand: Rand): string {
  const yy = pad(randInt(rand, 0, 99), 2);
  const mm = pad(80 + randInt(rand, 1, 12), 2); // 1800s century encoding
  const dd = pad(randInt(rand, 1, 28), 2);
  let serial = '';
  for (let i = 0; i < 4; i++) serial += randDigit(rand);
  const body = `${yy}${mm}${dd}${serial}`;
  return `${body}${peselChecksum(body)}`;
}

/** UK NINO display shape: 2 prefix letters, 6 digits, suffix A-D. */
const NINO_SHAPE = /^[A-Za-z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Da-d]$/;

/** UK NHS display shape: 10 digits, optionally grouped 3-3-4. */
const NHS_SHAPE = /^\d{3}\s?\d{3}\s?\d{4}$/;

const NHS_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * Mod-11-valid 10-digit NHS number in the 999 range, which NHS Digital
 * reserves for test data and never issues to patients (T100) - the NHS
 * counterpart of the 1800s PESEL marker. Bodies whose check digit
 * computes to 10 have no valid final digit; redraw the serial then.
 */
function generateNhsNumber(rand: Rand): string {
  for (;;) {
    let body = '999';
    for (let i = 0; i < 6; i++) body += randDigit(rand);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(body[i]) * NHS_WEIGHTS[i];
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return body + String(check === 11 ? 0 : check);
  }
}

/**
 * UK NINO stand-in (T100): NINOs carry no checksum, so the safety marker
 * is the QQ prefix - Q is never used in real prefixes, and HMRC's own
 * forms use QQ 12 34 56 C as the documentation example (the NINO
 * equivalent of an RFC 2606 reserved domain). Digits are substituted,
 * the suffix stays in the real A-D range, and the original's spacing
 * and letter case are preserved.
 */
function generateNino(original: string, rand: Rand): string {
  const suffix = 'ABCD'[randInt(rand, 0, 3)];
  let letterIdx = 0;
  return original.replace(/[A-Za-z0-9]/g, (ch) => {
    if (ch >= '0' && ch <= '9') return randDigit(rand);
    letterIdx++;
    const repl = letterIdx <= 2 ? 'Q' : suffix;
    return ch === ch.toLowerCase() ? repl.toLowerCase() : repl;
  });
}

/** US EIN display shape: 2-7 hyphenated. */
const US_EIN_SHAPE = /^\d{2}-\d{7}$/;

/**
 * EIN campus prefixes the IRS has never assigned - the exact complement
 * of the valid-prefix classes in rules/us.json (regex:us:ein), so a
 * stand-in built on one can never be a real employer's EIN.
 */
const EIN_UNASSIGNED_PREFIXES = [
  '07', '08', '09', '17', '18', '19', '28', '29',
  '49', '69', '70', '78', '79', '89', '96', '97',
] as const;

/**
 * US SSN-shaped stand-in (T101): 9 digits mapped positionally onto the
 * original's layout. The area is forced into 900-999, which the SSA has
 * never allocated (and the post-2011 randomization scheme explicitly
 * excludes), so the value can never be a real SSN. That alone is not
 * enough: ITINs live exactly in the 9xx area, so the group is drawn from
 * 01-49 - outside every valid ITIN group range (50-65, 70-88, 90-92,
 * 94-99) - making the stand-in provably neither an SSN nor an ITIN.
 */
function generateSsnStandIn(original: string, rand: Rand): string {
  const area = String(randInt(rand, 900, 999));
  const group = pad(randInt(rand, 1, 49), 2);
  const serial = pad(randInt(rand, 1, 9999), 4);
  const digits = `${area}${group}${serial}`;
  let i = 0;
  return original.replace(/\d/g, () => digits[i++]);
}

/** US EIN stand-in (T101): a never-assigned campus prefix + 7 digits. */
function generateEinStandIn(original: string, rand: Rand): string {
  let digits = pick(rand, EIN_UNASSIGNED_PREFIXES);
  for (let i = 0; i < 7; i++) digits += randDigit(rand);
  let i = 0;
  return original.replace(/\d/g, () => digits[i++]);
}

function generateNationalId(original: string, rand: Rand): string {
  const digits = original.replace(/\D/g, '');
  if (digits.length === 11 && /^\d{11}$/.test(original.trim())) {
    return generatePesel(rand);
  }
  const trimmed = original.trim();
  if (NINO_SHAPE.test(trimmed)) {
    return generateNino(original, rand);
  }
  if (digits.length === 10 && NHS_SHAPE.test(trimmed)) {
    const nhs = generateNhsNumber(rand);
    let i = 0;
    return original.replace(/\d/g, () => nhs[i++]);
  }
  if (US_EIN_SHAPE.test(trimmed)) {
    return generateEinStandIn(original, rand);
  }
  if (digits.length === 9) {
    // US SSN shape (hyphenated or bare 9 digits): never-issued area AND
    // never-valid ITIN group.
    return generateSsnStandIn(original, rand);
  }
  return sameShapeDigits(original, rand);
}

// ── US ABA routing numbers (OTHER entity type) ─────────────

/** 3-7-1 weighted mod-10 sum of a 9-digit ABA routing number. */
function abaChecksumOk(digits: string): boolean {
  const n = digits.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

/**
 * US ABA routing stand-in (T101): checksum-valid so shape-checking
 * consumers keep accepting it, but with the 99 leading pair - the ABA
 * assigns only 00-12, 21-32, 61-72, and 80, so a 99xxxxxxx number can
 * never be a real institution's routing number (the checksummed
 * counterpart of the NHS 999 test range and the NINO QQ prefix).
 */
function generateRoutingStandIn(original: string, rand: Rand): string {
  let body = '99';
  for (let i = 0; i < 6; i++) body += randDigit(rand);
  const n = body.split('').map(Number);
  // The 9th digit has weight 1 in the 3-7-1 scheme: choose it to zero
  // the sum mod 10, so a valid check digit always exists.
  const partial = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5]);
  const digits = body + String((10 - (partial % 10)) % 10);
  let i = 0;
  return original.replace(/\d/g, () => digits[i++]);
}

/**
 * OTHER is a grab-bag type; the only shape given special treatment is a
 * checksum-valid 9-digit ABA routing number (regex:us:routing emits
 * OTHER). Everything else keeps the generic same-shape substitution,
 * which would otherwise break the routing checksum - or worse, randomly
 * land on a real institution's number.
 */
function generateOther(original: string, rand: Rand): string {
  const trimmed = original.trim();
  if (/^\d{9}$/.test(trimmed) && abaChecksumOk(trimmed)) {
    return generateRoutingStandIn(original, rand);
  }
  return sameShape(original, rand);
}

// ── CREDIT_CARD ────────────────────────────────────────────

function luhnCheckDigit(payload: string): number {
  let sum = 0;
  let double = true; // start doubling from the rightmost payload digit
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = Number(payload[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

function generateCreditCard(original: string, rand: Rand): string {
  const digitCount = (original.match(/\d/g) ?? []).length;
  if (digitCount < 2) return sameShapeDigits(original, rand);
  let payload = '';
  for (let i = 0; i < digitCount - 1; i++) payload += randDigit(rand);
  const full = payload + String(luhnCheckDigit(payload));
  let i = 0;
  return original.replace(/\d/g, () => full[i++]);
}

// ── IP_ADDRESS ─────────────────────────────────────────────

function generateIp(original: string, rand: Rand): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(original.trim());
  if (m) {
    return [0, 0, 0, 0].map(() => randInt(rand, 1, 254)).join('.');
  }
  // IPv6 and anything else: substitute hex digits, keep structure.
  return original.replace(/[0-9a-fA-F]/g, (ch) => {
    const v = randInt(rand, 0, 15).toString(16);
    return ch === ch.toUpperCase() && /[a-f]/i.test(ch) ? v.toUpperCase() : v;
  });
}

// ── ADDRESS / COMPANY (pool-based, kept simple) ────────────

/**
 * Locale from the address keyword first (rue/calle/via/stra\u00dfe/\u0432\u0443\u043b...),
 * then distinctive characters; EN format is the fallback (T073).
 */
function detectAddressPack(original: string): LocalePack {
  for (const pack of LOCALE_PACKS) {
    if (pack.addressHint?.test(original)) return pack;
  }
  for (const pack of LOCALE_PACKS) {
    if (pack.chars?.test(original)) return pack;
  }
  for (const pack of LOCALE_PACKS) {
    if (pack.scriptFallback?.test(original)) return pack;
  }
  return EN_PACK;
}

function generateAddress(original: string, rand: Rand): string {
  const pack = detectAddressPack(original);
  const n = randInt(rand, 1, 120);
  const streets = pack.streets ?? EN_PACK.streets!;
  const format = pack.formatAddress ?? EN_PACK.formatAddress!;
  return format(pick(rand, streets), n);
}

function generateCompany(original: string, rand: Rand): string {
  const trimmed = original.trim();
  // Latin suffixes must follow a space ('SAAB' must not shed an 'AB');
  // CJK suffixes attach directly (\u4f8b: \u2026\u6709\u9650\u516c\u53f8).
  const suffix = COMPANY_SUFFIXES.find((s) =>
    /^[\x00-\x7f]+$/.test(s) ? trimmed.endsWith(` ${s}`) : trimmed.endsWith(s),
  );
  // Legal form decides the locale first (GmbH is German wherever it
  // appears), then distinctive characters; EN pool is the fallback.
  let pack: LocalePack | null = null;
  if (suffix !== undefined) {
    pack = LOCALE_PACKS.find((p) => p.companySuffixHint?.test(suffix)) ?? null;
  }
  if (!pack) pack = LOCALE_PACKS.find((p) => p.chars?.test(original)) ?? null;
  const base = pick(rand, pack?.companies ?? EN_PACK.companies!);
  if (!suffix) return base;
  const spaced = trimmed.endsWith(` ${suffix}`);
  return spaced ? `${base} ${suffix}` : `${base}${suffix}`;
}

/**
 * Test/diagnostic probe (T073): which locale pack a PERSON value would
 * use. Not part of the anonymization data path.
 */
export function detectSurrogateLocale(value: string): string {
  return detectPersonPack(value).id;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Generate a surrogate for one entity. Pure and deterministic in
 * (ctx.salt, type, original, attempt); bump `attempt` to re-derive after
 * a collision.
 */
export function generateSurrogate(
  original: string,
  type: EntityType,
  ctx: SurrogateContext,
  attempt = 0,
): string {
  const rand = rngFor(ctx.salt, type, original, attempt);
  switch (type) {
    case 'PERSON': return generatePerson(original, rand);
    case 'EMAIL': return generateEmail(original, ctx, rand);
    case 'DATE': return generateDate(original, ctx, rand, attempt);
    case 'PHONE': return generatePhone(original, rand);
    case 'IBAN': return generateIban(original, rand);
    case 'SSN': return generateNationalId(original, rand);
    case 'CREDIT_CARD': return generateCreditCard(original, rand);
    case 'IP_ADDRESS': return generateIp(original, rand);
    case 'ADDRESS': return generateAddress(original, rand);
    case 'COMPANY': return generateCompany(original, rand);
    case 'CURRENCY': return sameShapeDigits(original, rand);
    case 'OTHER': return generateOther(original, rand);
    default: return sameShape(original, rand);
  }
}

/**
 * Collision-safe wrapper: re-derives with a bumped attempt while the
 * candidate equals the original or `isTaken` reports a clash (another
 * original value or an already-issued replacement); after bounded retries
 * it appends digits until unique. Termination is guaranteed because the
 * taken set is finite.
 */
export function generateUniqueSurrogate(
  original: string,
  type: EntityType,
  ctx: SurrogateContext,
  isTaken: (candidate: string) => boolean,
): string {
  const MAX_ATTEMPTS = 8;
  let candidate = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    candidate = generateSurrogate(original, type, ctx, attempt);
    if (candidate !== original && !isTaken(candidate)) return candidate;
  }
  for (let n = 2; ; n++) {
    const suffixed = `${candidate}${n}`;
    if (suffixed !== original && !isTaken(suffixed)) return suffixed;
  }
}
