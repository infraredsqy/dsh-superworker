import { isPfError, type RecordError } from '../../src/errors.ts';

/**
 * Catch a call that is supposed to be rejected and hand the rejection to the assertion that
 * reads the code and the message.
 *
 * Two reasons to use it: Vitest's `rejects` cannot easily look at `code` and the message at the
 * same time, and a rejection point that passes but stays silent (a gate that should reject but
 * lets the call through, say) always turns red here instead of being hidden by the assertions
 * further down.
 */
export async function rejection(promise: Promise<unknown>): Promise<RecordError> {
  try {
    await promise;
  } catch (error) {
    if (isPfError(error)) return error;
    throw error;
  }
  throw new Error('this call should have been rejected, but it went through');
}
