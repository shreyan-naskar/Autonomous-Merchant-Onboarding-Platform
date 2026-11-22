import { humanize } from '@app/shared'

const FIELD_NAMES: Record<string, string> = {
  pan: 'PAN',
  name: 'Name on PAN card',
  gst: 'GSTIN',
  legal_name: 'Legal name',
  bank_account: 'Account number',
  ifsc: 'IFSC',
  account_holder: 'Account holder',
}

export const fieldName = (field: string) => FIELD_NAMES[field] ?? humanize(field)
