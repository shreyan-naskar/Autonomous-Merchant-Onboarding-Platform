import { DOCUMENT_LABELS, FORM_FIELD_LABELS, type DocumentType, type MerchantFormField, type MerchantRequest } from '@app/shared';
import { DOCUMENT_FIELDS } from './extract.js';

/* Plain-language requests for missing information. Messages never contain PAN, GSTIN or account values. */

const FIELD_ON_DOC: Record<string, string> = {
  pan: 'PAN',
  name: 'name',
  gst: 'GSTIN',
  legal_name: 'legal name',
  bank_account: 'account number',
  ifsc: 'IFSC',
  account_holder: 'account holder name',
};

const docLower = (t: DocumentType) => DOCUMENT_LABELS[t].replace(/^Bank/, 'bank');

export interface MerchantRequests {
  requests: MerchantRequest[];
  formFields: MerchantFormField[];
  documents: DocumentType[];
}

/** `missing` labels: `form.<field>`, `document.<TYPE>`, `<TYPE>.<payload key>`. */
export function merchantRequests(missing: readonly string[]): MerchantRequests {
  const requests: MerchantRequest[] = [];
  const formFields = new Set<MerchantFormField>();
  const documents = new Set<DocumentType>();

  for (const item of missing) {
    const [scope, name] = item.split('.') as [string, string];
    if (scope === 'form') {
      const f = name as MerchantFormField;
      formFields.add(f);
      requests.push({ code: 'MISSING_FIELD', field: f, message: `Please enter your ${FORM_FIELD_LABELS[f]}.` });
    } else if (scope === 'document') {
      const t = name as DocumentType;
      documents.add(t);
      requests.push({ code: 'MISSING_DOCUMENT', document: t, message: `Please upload your ${docLower(t)}.` });
    } else {
      const t = scope as DocumentType;
      const field = DOCUMENT_FIELDS[t]?.find((s) => s.key === name)?.field ?? name;
      documents.add(t);
      requests.push({
        code: 'MISSING_VALUE',
        document: t,
        field,
        message: `Your ${docLower(t)} does not show the ${FIELD_ON_DOC[field] ?? field}. Please upload the complete document.`,
      });
    }
  }
  return { requests, formFields: [...formFields], documents: [...documents] };
}
