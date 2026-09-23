/**
 * T124 gold corpus: English (mix of UK and US documents).
 * Authored as segments; offsets computed by doc(). See ../schema.mts.
 */
import { doc } from '../schema.mts';
import type { CorpusDoc } from '../schema.mts';

export const docs: CorpusDoc[] = [
  // UK onboarding email. Traps: "a ford across the river", "in May".
  doc('en-01', 'en', 'email', [
    'Dear team, please onboard ', ['James Whitfield', 'PERSON'], ' starting ',
    ['4 March 2026', 'DATE'], '. His email is ', ['j.whitfield@example.co.uk', 'EMAIL'],
    ' and his mobile is ', ['07911 123456', 'PHONE'], '. He will report to ',
    ['Sarah Ogden', 'PERSON'], ' at the ', ['Marlowe Analytics Ltd', 'COMPANY'],
    ' office at ', ['14 Priory Lane', 'ADDRESS'], ', ', ['GU2 7XH', 'ADDRESS'], ' ',
    ['Guildford', 'ADDRESS'],
    '. Heads up: there is a ford across the river near the car park, so allow extra time in May when it floods.',
  ]),

  // US chat message pasted to an AI assistant. Traps: "singer sewing machine", "used-car pitch".
  doc('en-02', 'en', 'chat', [
    'Hey, can you help me draft a follow-up note? I met ', ['Daniel Okafor', 'PERSON'],
    ' from ', ['Brightline Systems Inc.', 'COMPANY'],
    ' at the expo last week. He said to call him on ', ['(415) 555-0173', 'PHONE'],
    ' or email ', ['d.okafor@brightline-sys.com', 'EMAIL'],
    '. Their staging box sits at ', ['203.0.113.42', 'IP_ADDRESS'],
    ' and my hotel bill came to ', ['$482.19', 'CURRENCY'],
    ', which I want reimbursed. Also mention that ', ['Okafor', 'PERSON'],
    ' wants the demo before ', ['September 12, 2026', 'DATE'],
    ". Don't make it sound like a used-car pitch, and skip the singer sewing machine jokes this time.",
  ]),

  // UK HR record. Trap: "hoover up".
  doc('en-03', 'en', 'hr', [
    'CONFIDENTIAL HR RECORD. Employee: ', ['Priya Bhattacharya', 'PERSON'],
    ', date of birth ', ['12/03/1985', 'DATE'],
    '. National Insurance number: ', ['QQ 12 34 56 C', 'SSN'],
    '. Home address: ', ['88 Alderley Road', 'ADDRESS'], ', ', ['M20 4WX', 'ADDRESS'],
    ' ', ['Manchester', 'ADDRESS'],
    '. Contact: ', ['+44 161 496 0201', 'PHONE'],
    ', personal email ', ['priya.bha@examplemail.co.uk', 'EMAIL'], '. ',
    ['Bhattacharya', 'PERSON'], ' joined on ', ['1 June 2019', 'DATE'],
    ' and reports to the head of engineering. Salary band: ', ['£58,400', 'CURRENCY'],
    ' per annum. Note: she will hoover up any data-quality issue you hand her.',
  ]),

  // US medical intake. Traps: "enjoys reading", "frankfurter".
  doc('en-04', 'en', 'medical', [
    'Patient intake summary. Name: ', ['Robert Castellano', 'PERSON'],
    ', DOB ', ['03/22/1958', 'DATE'], ', SSN ', ['123-45-6789', 'SSN'],
    '. Presented on ', ['August 4, 2026', 'DATE'],
    ' with intermittent chest pain. Emergency contact: his daughter ',
    ['Maria Castellano', 'PERSON'], ', phone ', ['(312) 555-0142', 'PHONE'],
    '. Insurance through ', ['Lakeshore Mutual Health', 'COMPANY'],
    '. Mailing address: ', ['2101 W Harrison St', 'ADDRESS'], ', ',
    ['Chicago', 'ADDRESS'], ', IL ', ['60612', 'ADDRESS'],
    '. The patient enjoys reading and long walks, and asked whether a frankfurter now and then would hurt his cholesterol.',
  ]),

  // UK invoice. Trap: "mark my words".
  doc('en-05', 'en', 'invoice', [
    'INVOICE No. 2026-0417, issued ', ['15 April 2026', 'DATE'],
    '. From: ', ['Hartwell & Grey Consulting Ltd', 'COMPANY'], ', ',
    ['3 Bishopsgate', 'ADDRESS'], ', ', ['EC2N 3AB', 'ADDRESS'], ' ',
    ['London', 'ADDRESS'], '. Bill to: ', ['Eleanor Vance', 'PERSON'],
    '. Amount due: ', ['£12,750.00', 'CURRENCY'],
    '. Please pay by bank transfer to IBAN ', ['GB29 NWBK 6016 1331 9268 19', 'IBAN'],
    ' within 30 days. Queries: ', ['accounts@hartwellgrey.example.com', 'EMAIL'],
    ' or ', ['020 7946 0958', 'PHONE'],
    '. Chasing late payment is an uphill battle, mark my words.',
  ]),

  // US settlement agreement. Trap: "bill the other party".
  doc('en-06', 'en', 'legal', [
    'SETTLEMENT AGREEMENT dated ', ['June 30, 2026', 'DATE'], ' between ',
    ['Meredith Klein', 'PERSON'], ' ("Claimant") and ',
    ['Vantage Logistics Corporation', 'COMPANY'],
    ' ("Respondent"). The Claimant, residing at ', ['447 Beacon Street', 'ADDRESS'],
    ', ', ['Boston', 'ADDRESS'], ', MA ', ['02115', 'ADDRESS'],
    ', agrees to release all claims in exchange for ', ['$95,000', 'CURRENCY'],
    ', payable within ten business days. Counsel for the Respondent, ',
    ['Thomas Abernathy', 'PERSON'], ', may be reached at ', ['+1 617 555 0188', 'PHONE'],
    '. Nothing herein is an admission of liability, and neither party shall bill the other for costs already incurred.',
  ]),

  // UK casual message. Traps: "a huge bath", "a ford on the lane".
  doc('en-07', 'en', 'casual', [
    "Quick one before I forget: I booked the cottage for ", ['22 August 2026', 'DATE'],
    " and paid the deposit with my card, full number ", ['4929 1834 7712 9034', 'CREDIT_CARD'],
    ", expiry 09/28, don't judge me. Split works out to ", ['£310', 'CURRENCY'],
    ' each. ', ['Nadia', 'PERSON'], " said she'll drive, text her on ",
    ['07700 900123', 'PHONE'], '. My cousin ', ['Lewis Hartley', 'PERSON'],
    " might join too, he's the one who works at ", ['Torchwood Media', 'COMPANY'],
    ". The place has a huge bath so we're skipping the spa. Bring wellies, there's a ford on the lane in.",
  ]),

  // US application form. Trap: "the first monday of the month".
  doc('en-08', 'en', 'form', [
    'Account application form.\nFull name: ', ['Angela Ruiz-Thompson', 'PERSON'],
    '\nDate of birth: ', ['11/02/1990', 'DATE'],
    '\nSocial Security number: ', ['987-65-4320', 'SSN'],
    '\nStreet address: ', ['9021 Cedar Hollow Drive', 'ADDRESS'],
    '\nCity: ', ['Austin', 'ADDRESS'],
    '\nZIP: ', ['78704', 'ADDRESS'],
    '\nPhone: ', ['512-555-0199', 'PHONE'],
    '\nEmail: ', ['a.ruizthompson@example.org', 'EMAIL'],
    '\nEmployer: ', ['Concordia BioLabs', 'COMPANY'],
    '\nMonthly income: ', ['$7,200', 'CURRENCY'],
    '\nPreferred contact window: any weekday, but not the first monday of the month.',
  ]),
];
