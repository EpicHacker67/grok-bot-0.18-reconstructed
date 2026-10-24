/** Only matched contact names, phone numbers and emails leave the local process. */
export function contactsScript(query: string): string {
  return `const query = ${JSON.stringify(query)};
function normalized(value) { return String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim(); }
function phoneRecipient(value) {
  const phone = String(value || '').trim();
  if (!/^\\+?[\\d\\s().-]+$/.test(phone)) return null;
  const digits = phone.replace(/[^\\d]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? (phone.startsWith('+') ? '+' : '') + digits : null;
}
const terms = normalized(query).split(/\\s+/).filter(Boolean);
if (!terms.length) throw new Error('Enter a contact name.');
const contacts = Application('com.apple.AddressBook');
const names = contacts.people.name();
const nicknames = contacts.people.nickname();
function matchesQuery(name, nickname) {
  const words = normalized(name + ' ' + nickname).split(/\\s+/);
  return terms.every(term => words.some(word => word.startsWith(term)));
}
const matches = [];
let total = 0;
for (let index = 0; index < names.length; index++) {
  if (!matchesQuery(names[index] || '', nicknames[index] || '')) continue;
  const person = contacts.people[index];
  const name = person.name() || '';
  const nickname = person.nickname() || '';
  if (!matchesQuery(name, nickname)) continue;
  total++;
  if (matches.length >= 20) continue;
  const phones = person.phones().slice(0, 20).map(phone => ({label: phone.label() || '', value: phone.value() || ''})).map(phone => ({...phone, recipient: phoneRecipient(phone.value)}));
  const emails = person.emails().slice(0, 20).map(email => ({label: email.label() || '', value: email.value() || ''})).filter(email => /^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$/.test(email.value));
  const numbers = [...new Set(phones.map(phone => phone.recipient).filter(Boolean))];
  const mobile = [...new Set(phones.filter(phone => /mobile|iphone|cell/i.test(phone.label)).map(phone => phone.recipient).filter(Boolean))];
  const addresses = [...new Set(emails.map(email => email.value))];
  const preferredRecipient = numbers.length === 1 ? numbers[0] : mobile.length === 1 ? mobile[0] : numbers.length === 0 && addresses.length === 1 ? addresses[0] : null;
  matches.push({id: person.id(), name, phones, emails, preferredRecipient});
}
JSON.stringify({matches, total, truncated: total > matches.length, guidance: total === 1 && matches[0].preferredRecipient ? 'Use this contact’s preferredRecipient. Do not ask the user to repeat the number.' : total === 0 ? 'No match. Try another spelling before asking the user for contact details.' : 'Ask which matching contact or number the user means; do not guess.'});`;
}

export function parseContactQuery(raw: unknown): string {
  const query = raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).query : undefined;
  if (typeof query !== "string" || !query.trim() || query.length > 120 || /[\u0000-\u001f]/.test(query) || !/[\p{L}\p{N}]/u.test(query)) {
    throw new Error("Provide a contact name to search (1–120 characters).");
  }
  return query.trim();
}
