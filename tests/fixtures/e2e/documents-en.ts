import type { E2eDocument } from './types.ts';

export const EN_DOCUMENTS: E2eDocument[] = [
  {
    id: 'en-email-01',
    lang: 'en',
    kind: 'email',
    text: `Subject: Contract renewal for the Riverside office

Hi Sarah,

following up on my call with Michael Thompson, the renewal paperwork is ready. Please countersign and return it by March 15, 2024. Michael confirmed that the rent stays at 3,200 GBP per month and that invoices go to 14 Baker Street, London, EC2A 1NT.

The deposit should be transferred to GB29 NWBK 6016 1331 9268 19. You can reach Michael on +44 20 7946 0958 or at michael.thompson@landlord-example.co.uk. Copying Sarah Mitchell (sarah.mitchell@tenant-example.com) as agreed.

Best regards,
Daniel Hughes
Property Manager`,
    persons: ['Sarah', 'Michael Thompson', 'Michael', 'Sarah Mitchell', 'Daniel Hughes'],
    pii: [
      'Michael Thompson', 'Sarah Mitchell', 'Daniel Hughes', 'March 15, 2024', '14 Baker Street', 'EC2A 1NT',
      'GB29 NWBK 6016 1331 9268 19', '+44 20 7946 0958', 'michael.thompson@landlord-example.co.uk',
      'sarah.mitchell@tenant-example.com',
    ],
  },
  {
    id: 'en-email-02',
    lang: 'en',
    kind: 'email',
    text: `Hello Mr. Roberts,

thank you for your order. Your appointment is confirmed for 2024-04-09 at 9:30. Please bring a photo ID; the name on the booking is James Roberts and the delivery address on file is 221B Baker Street, London, NW1 6XE.

If anything changes, call us on +44 7911 123456 or reply to bookings@garage-example.co.uk. Our technician, Emily Clarke, will contact you the day before from +44 161 496 0000.

Kind regards,
Emily Clarke
Customer Service`,
    persons: ['Roberts', 'James Roberts', 'Emily Clarke'],
    pii: [
      'James Roberts', 'Emily Clarke', '2024-04-09', '221B Baker Street', 'NW1 6XE', '+44 7911 123456',
      'bookings@garage-example.co.uk', '+44 161 496 0000',
    ],
  },
  {
    id: 'en-email-03',
    lang: 'en',
    kind: 'email',
    text: `Hey Chris,

here are the payment details for the venue: payee Laura Bennett, IBAN GB33 BUKB 2020 1555 5555 55, reference "hall 20 April 2024". Laura asked for a confirmation by Friday.

Feel free to call her directly on +1 (555) 123-4567; her email is laura.bennett@venue-example.com. I am on the road until 3 pm but reachable at chris.walker@mail-example.com afterwards.

Cheers,
Chris Walker`,
    persons: ['Chris', 'Laura Bennett', 'Laura', 'Chris Walker'],
    pii: [
      'Laura Bennett', 'Chris Walker', 'GB33 BUKB 2020 1555 5555 55', '20 April 2024', '+1 (555) 123-4567',
      'laura.bennett@venue-example.com', 'chris.walker@mail-example.com',
    ],
  },
  {
    id: 'en-contract-01',
    lang: 'en',
    kind: 'contract',
    text: `RESIDENTIAL TENANCY AGREEMENT

This agreement is made on 01/02/2024 between:

1. Robert Anderson of 45 Highfield Road, Manchester, M14 5QA (the Landlord), and
2. Patricia Foster of 8 Mill Lane, Stockport, SK4 1AB (the Tenant).

1. The Landlord lets to the Tenant the flat at 45 Highfield Road. The rent of 950 GBP per month is payable to account GB29 NWBK 6016 1331 9268 19 on the 1st day of each month.
2. Notices to the Tenant are sent to patricia.foster@mail-example.com or by phone to +44 7700 900123. Robert Anderson collects his post in person.
3. The Tenant's national insurance number, AB 12 34 56 C, is held for the deposit scheme only.

Landlord: Robert Anderson
Tenant: Patricia Foster`,
    persons: ['Robert Anderson', 'Patricia Foster'],
    pii: [
      'Robert Anderson', 'Patricia Foster', '01/02/2024', '45 Highfield Road', 'M14 5QA', '8 Mill Lane', 'SK4 1AB',
      'GB29 NWBK 6016 1331 9268 19', 'patricia.foster@mail-example.com', '+44 7700 900123', 'AB 12 34 56 C',
    ],
  },
  {
    id: 'en-contract-02',
    lang: 'en',
    kind: 'contract',
    text: `CONSULTING SERVICES AGREEMENT No. 7/2024

Client: Pixel Studio Ltd, 22 Harbour Avenue, Leeds, LS1 4AP, represented by its director Steven Morgan.
Consultant: Jennifer Collins, of 4 Lime Grove, Leeds, LS2 9JT, email jennifer.collins@design-example.com, phone +44 113 496 0123.

1. The Consultant shall deliver the brand identity by 30/06/2024.
2. The fee of 9,000 GBP is payable to the Consultant's account GB33 BUKB 2020 1555 5555 55 within 14 days of acceptance.
3. The Client's point of contact is Steven Morgan.

For the Client: Steven Morgan
Consultant: Jennifer Collins`,
    persons: ['Steven Morgan', 'Jennifer Collins'],
    pii: [
      'Steven Morgan', 'Jennifer Collins', '22 Harbour Avenue', 'LS1 4AP', '4 Lime Grove', 'LS2 9JT',
      'jennifer.collins@design-example.com', '+44 113 496 0123', '30/06/2024', 'GB33 BUKB 2020 1555 5555 55',
    ],
  },
  {
    id: 'en-contract-03',
    lang: 'en',
    kind: 'contract',
    text: `AMENDMENT No. 2 to the employment contract dated 15/09/2021

Employer: Beam Builders Merchants PLC, 9 Factory Road, Birmingham, B1 1AA.
Employee: Andrew Phillips, of 18 Spring Close, Solihull, B91 3DL, date of birth 10/04/1979.

The parties agree that from 01/05/2024 Andrew Phillips takes the position of warehouse manager with a salary of 42,000 GBP per year. All other terms remain unchanged.

Work contact: andrew.phillips@beam-example.co.uk, +44 121 496 0456. Salary is paid to account GB29 NWBK 6016 1331 9268 19.

For the Employer: Elizabeth Turner, HR Director
Employee: Andrew Phillips`,
    persons: ['Andrew Phillips', 'Elizabeth Turner'],
    pii: [
      'Andrew Phillips', 'Elizabeth Turner', '15/09/2021', '18 Spring Close', 'B91 3DL', '10/04/1979', '01/05/2024',
      'andrew.phillips@beam-example.co.uk', '+44 121 496 0456', 'GB29 NWBK 6016 1331 9268 19',
    ],
  },
  {
    id: 'en-cv-01',
    lang: 'en',
    kind: 'cv',
    text: `MARGARET EVANS
Data Analyst

Contact: margaret.evans@cv-example.com | +44 7911 654321 | 5 Acacia Drive, Bristol, BS1 5TR
Date of birth: 12/07/1991

Experience
2020-2024 Data Analyst, Dot Online Retail Ltd, Bristol. Built sales reporting, worked closely with the team of Benjamin Carter.
2017-2020 Junior Analyst, Regional Bank PLC, Bath.

Education
2012-2017 University of Bristol, Applied Mathematics.

References: Benjamin Carter, Team Lead, benjamin.carter@dot-example.com.

I consent to the processing of my personal data for recruitment purposes.`,
    persons: ['MARGARET EVANS', 'Benjamin Carter'],
    pii: [
      'Margaret Evans', 'Benjamin Carter', 'margaret.evans@cv-example.com', '+44 7911 654321', '5 Acacia Drive',
      'BS1 5TR', '12/07/1991', 'benjamin.carter@dot-example.com',
    ],
  },
  {
    id: 'en-cv-02',
    lang: 'en',
    kind: 'cv',
    text: `Thomas Wright
Maintenance Engineer

Address: 31 Walk Lane, Glasgow, G1 2FF
Phone: +44 141 496 0789
Email: thomas.wright@cv-example.com
Born 03/11/1987

Profile
More than ten years on production lines. Responsible for planning inspections and supervising a team of six technicians. Led the last project together with Dorothy Sullivan.

Employment
2016-2024 Wave Engineering PLC, Glasgow, maintenance engineer.
2011-2016 North Shipyard Ltd, Greenock, technician.

Referee: Dorothy Sullivan, Production Director, phone +44 141 496 0555.`,
    persons: ['Thomas Wright', 'Dorothy Sullivan'],
    pii: [
      'Thomas Wright', 'Dorothy Sullivan', '31 Walk Lane', 'G1 2FF', '+44 141 496 0789',
      'thomas.wright@cv-example.com', '03/11/1987', '+44 141 496 0555',
    ],
  },
  {
    id: 'en-note-01',
    lang: 'en',
    kind: 'note',
    text: `Project meeting notes, 2024-05-14

Present: Paul Richardson (project manager), Justine Nelson (legal), Ryan Campbell (client).

1. Ryan Campbell presented his comments on the schedule. Go-live moved to 30/09/2024.
2. Justine Nelson will prepare the contract amendment; the draft goes to ryan.campbell@client-example.com by the end of the week.
3. Paul will collect quotes for the additional work. Contractor contact: +44 7700 900456.
4. Advance invoices go to the client's address: 8 Green Street, Sheffield, S1 2HH.

Next meeting: 28/05/2024 at the client's office. Notes taken by Paul Richardson.`,
    persons: ['Paul Richardson', 'Justine Nelson', 'Ryan Campbell', 'Paul'],
    pii: [
      'Paul Richardson', 'Justine Nelson', 'Ryan Campbell', '2024-05-14', '30/09/2024',
      'ryan.campbell@client-example.com', '+44 7700 900456', '8 Green Street', 'S1 2HH', '28/05/2024',
    ],
  },
  {
    id: 'en-note-02',
    lang: 'en',
    kind: 'note',
    text: `Internal memo, 03/06/2024

Subject: complaint about order no. 4471

In a phone call (+44 20 7946 0123) Peter Robinson reported that the parcel delivered on 31/05/2024 to 2 Poplar Road, Reading, RG1 3BB arrived damaged. Peter Morris looked into it on the warehouse side. Peter confirmed that the parcel had been packed according to procedure.

Outcome: the customer receives a replacement by 10/06/2024 and the return cost (120 GBP) is covered by the company. Confirmation sent to peter.robinson@client-example.com.

Written by: Barbara Jenkins, Customer Care`,
    // "Peter" alone fits two people: the session must not guess (R5).
    persons: ['Peter Robinson', 'Peter Morris', 'Peter', 'Barbara Jenkins'],
    pii: [
      'Peter Robinson', 'Peter Morris', 'Barbara Jenkins', '03/06/2024', '+44 20 7946 0123', '31/05/2024',
      '2 Poplar Road', 'RG1 3BB', '10/06/2024', 'peter.robinson@client-example.com',
    ],
  },
];
