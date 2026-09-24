import { PL_DOCUMENTS } from './documents-pl.ts';
import { EN_DOCUMENTS } from './documents-en.ts';
import { DE_DOCUMENTS } from './documents-de.ts';

export type { E2eDocument, E2eKind, E2eLang } from './types.ts';
export type { ReplyMode, ReplyTemplate } from './templates.ts';
export { REPLY_TEMPLATES } from './templates.ts';

export const E2E_DOCUMENTS = [...PL_DOCUMENTS, ...EN_DOCUMENTS, ...DE_DOCUMENTS];
