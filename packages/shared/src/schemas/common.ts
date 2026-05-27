import { z } from "zod";

/**
 * ULID: 26-character Crockford Base32 string.
 * Case-insensitive regex matching.
 */
export const ulidSchema = z
  .string()
  .regex(/^[0-9A-HJ-KM-NP-TV-Za-hj-km-np-tv-z]{26}$/, "Invalid ULID format");

/**
 * ISO 8601 timestamp stored as TEXT.
 * Accepts standard ISO strings like "2026-05-27T12:00:00.000Z".
 */
export const timestampSchema = z.string().datetime({ message: "Invalid ISO 8601 timestamp" });

/**
 * Optional text field: allows null or undefined, trims whitespace.
 */
export const optionalText = z.string().trim().nullable().optional();
