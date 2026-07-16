import { describe, expect, test } from 'vitest';
import {
  MOCK_TWILIO_AUTH_TOKEN,
  TWILIO_SIGNATURE_HEADER,
  parseFormBody,
  readHeader,
  signTwilioForm,
  twilioSignatureBaseString,
  verifyTwilioSignature,
} from './twilio-signature.ts';
import { encodeForm } from './twilio-wire.ts';

/**
 * Twilio signature scheme (task 3a). The canonicalization — URL then every param
 * appended as `name + value` in ascending name order — is the Twilio-specific
 * logic a reimplementation gets wrong, so it is pinned against a hand-derived base
 * string (independent oracle). HMAC-SHA1+base64 over that base is standard crypto;
 * the end-to-end signature is pinned as a deterministic regression lock.
 */

// Twilio's documented example request.
const VECTOR_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const VECTOR_PARAMS: Record<string, string> = {
  Digits: '1234',
  To: '+18005551212',
  From: '+14158675310',
  Caller: '+14158675310',
  CallSid: 'CA1234567890ABCDE',
};
const VECTOR_TOKEN = '12345';

describe('twilioSignatureBaseString', () => {
  test('is the URL followed by name+value in ascending name order', () => {
    // Hand-derived per Twilio's rule: sort keys → CallSid, Caller, Digits, From, To.
    const expected =
      VECTOR_URL +
      'CallSid' +
      'CA1234567890ABCDE' +
      'Caller' +
      '+14158675310' +
      'Digits' +
      '1234' +
      'From' +
      '+14158675310' +
      'To' +
      '+18005551212';
    expect(twilioSignatureBaseString(VECTOR_URL, VECTOR_PARAMS)).toBe(expected);
  });

  test('is independent of the input param insertion order', () => {
    const shuffled: Record<string, string> = {
      To: '+18005551212',
      CallSid: 'CA1234567890ABCDE',
      From: '+14158675310',
      Digits: '1234',
      Caller: '+14158675310',
    };
    expect(twilioSignatureBaseString(VECTOR_URL, shuffled)).toBe(
      twilioSignatureBaseString(VECTOR_URL, VECTOR_PARAMS),
    );
  });
});

describe('signTwilioForm', () => {
  test('is deterministic for a fixed input (regression lock)', () => {
    expect(signTwilioForm(VECTOR_URL, VECTOR_PARAMS, VECTOR_TOKEN)).toBe(
      'GvWf1cFY/Q7PnoempGyD5oXAezc=',
    );
  });

  test('changes when the token changes', () => {
    const a = signTwilioForm(VECTOR_URL, VECTOR_PARAMS, 'token-a');
    const b = signTwilioForm(VECTOR_URL, VECTOR_PARAMS, 'token-b');
    expect(a).not.toBe(b);
  });
});

describe('verifyTwilioSignature', () => {
  const url = 'https://switchboard.test/wh/twilio/status';
  const params = { CallSid: 'CA9', CallStatus: 'completed', From: '+15550001111' };
  const rawBody = encodeForm(params);
  const signature = signTwilioForm(url, parseFormBody(rawBody), MOCK_TWILIO_AUTH_TOKEN);

  test('accepts a correctly-signed request (round-trips through form encoding)', () => {
    expect(verifyTwilioSignature(url, rawBody, signature, MOCK_TWILIO_AUTH_TOKEN)).toBe(true);
  });

  test('rejects a tampered body', () => {
    expect(
      verifyTwilioSignature(url, `${rawBody}&Injected=1`, signature, MOCK_TWILIO_AUTH_TOKEN),
    ).toBe(false);
  });

  test('rejects a tampered url', () => {
    expect(verifyTwilioSignature(`${url}?evil=1`, rawBody, signature, MOCK_TWILIO_AUTH_TOKEN)).toBe(
      false,
    );
  });

  test('rejects a tampered signature', () => {
    expect(verifyTwilioSignature(url, rawBody, `${signature}x`, MOCK_TWILIO_AUTH_TOKEN)).toBe(
      false,
    );
    expect(verifyTwilioSignature(url, rawBody, 'AAAA', MOCK_TWILIO_AUTH_TOKEN)).toBe(false);
  });

  test('rejects the wrong auth token', () => {
    expect(verifyTwilioSignature(url, rawBody, signature, 'not-the-token')).toBe(false);
  });

  test('rejects a missing/blank signature', () => {
    expect(verifyTwilioSignature(url, rawBody, undefined, MOCK_TWILIO_AUTH_TOKEN)).toBe(false);
    expect(verifyTwilioSignature(url, rawBody, '', MOCK_TWILIO_AUTH_TOKEN)).toBe(false);
  });
});

describe('readHeader', () => {
  test('finds the signature header case-insensitively', () => {
    expect(readHeader({ 'x-twilio-signature': 'sig' }, TWILIO_SIGNATURE_HEADER)).toBe('sig');
    expect(readHeader({ 'X-Twilio-Signature': 'sig' }, TWILIO_SIGNATURE_HEADER)).toBe('sig');
    expect(readHeader({ 'X-TWILIO-SIGNATURE': 'sig' }, TWILIO_SIGNATURE_HEADER)).toBe('sig');
  });

  test('returns undefined when absent', () => {
    expect(readHeader({ 'content-type': 'x' }, TWILIO_SIGNATURE_HEADER)).toBeUndefined();
  });
});
