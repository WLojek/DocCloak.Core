/**
 * T246: company, street and postal-city rules take any run of letters before (or after) their
 * anchor, so on prose they matched whole phrases. Found by the model test kit (keep-strings of
 * court decisions); the matches are cut to the name and dropped when no name is left.
 */
import { describe, it, expect } from 'vitest';
import { detectWithRegex } from '../../src/pipeline.ts';

const values = (text: string, region: string, detector: RegExp) =>
  detectWithRegex(text, region).filter((e) => detector.test(e.detector)).map((e) => e.value);

describe('company rules keep the name before the legal form (T246)', () => {
  it('drops prose before a legal form and a legal form alone', () => {
    const text = 'Entre janvier et mai, elle a réalisé de nombreuses rotations de camions pour le compte de la SCI LES JARDINS. '
      + 'ROBERT FRÈRES a mis la SCI en demeure. Le conducteur de travaux de la SAS a signé.';
    expect(values(text, 'fr', /:company$/)).toEqual([]);
  });

  it('keeps real names, with connectors and multi-word legal forms', () => {
    expect(values('Le bail est signé avec Dupont et Fils SARL. Le conseil est Capgemini SAS.', 'fr', /:company$/)).toEqual(['Dupont et Fils SARL', 'Capgemini SAS']);
    expect(values('Kredyt udzielił nam Santander Bank Polska S.A. w Krakowie.', 'pl', /:company$/)).toEqual(['Santander Bank Polska S.A.']);
    expect(values('Der Auftrag ging an Müller & Söhne GmbH.', 'de', /:company$/)).toEqual(['Müller & Söhne GmbH']);
  });

  it('a legal form glued to a word is not a company ("ACAS" is not "AC" + "AS")', () => {
    expect(values('The ACAS Code of Practice applies.', 'no', /:company$/)).toEqual([]);
  });
});

describe('street rules: a street name is capitalised (T246)', () => {
  it('a street word at the end keeps only the name before it', () => {
    expect(values('Herr Klaus Müller wohnt in der Königstraße 45.', 'de', /:street$/)).toEqual(['Königstraße 45']);
    expect(values('Kontor i Karl Johans gate 22, Oslo.', 'no', /:street$/)).toEqual(['Karl Johans gate 22']);
  });

  it('a one-letter lowercase street type is prose, not an address', () => {
    const text = "Avec intérêts au taux prévu par l'article L. 441-10 du code de commerce. Le greffier. L'ordonnance a été mise à disposition.";
    expect(values(text, 'all', /:(es|pt):street$/)).toEqual([]);
    expect(values('Vive en Calle Mayor 15 y en Rua Augusta 42.', 'all', /:(es|pt):street$/)).toEqual(['Calle Mayor 15', 'Rua Augusta 42']);
  });
});

describe('postal code and city: the city is capitalised (T246)', () => {
  it('drops a code followed by prose and cuts the city at the first lowercase word', () => {
    expect(values('Under the Employment Rights Act 1996 also succeeds.', 'no', /:postal$/)).toEqual([]);
    expect(values('Adresse: 10115 Berlin wohnt seit Jahren hier.', 'de', /:postal$/)).toEqual(['10115 Berlin']);
    expect(values('Siège: 60311 Frankfurt am Main.', 'de', /:postal$/)).toEqual(['60311 Frankfurt am Main']);
  });
});
