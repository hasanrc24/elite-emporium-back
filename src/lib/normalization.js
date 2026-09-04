import { AppError } from './errors.js';

export function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('880')) local = `0${digits.slice(3)}`;
  if (!/^01[3-9]\d{8}$/.test(local)) return null;
  return `+88${local}`;
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

export function normalizeIdentifier(value) {
  const phone = normalizePhone(value);
  if (phone) return { phone };
  const email = normalizeEmail(value);
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { email };
  throw AppError.badRequest('INVALID_IDENTIFIER', 'Enter a valid Bangladeshi phone number or email.', {
    identifier: ['Enter a valid Bangladeshi phone number or email.'],
  });
}
