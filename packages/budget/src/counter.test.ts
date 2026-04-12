import { describe, it, expect } from 'bun:test';
import { createTokenCounter } from './counter.js';

describe('createTokenCounter', () => {
  describe('chars4 strategy (default)', () => {
    it('no-arg default is chars4', () => {
      const count = createTokenCounter();
      // Math.ceil(4 / 4) = 1 (chars4), Math.ceil(4 / 3) = 2 (chars3)
      // Use 4-char string to discriminate between chars3 and chars4
      expect(count('abcd')).toBe(1);
    });

    it('explicit chars4', () => {
      const count = createTokenCounter('chars4');
      expect(count('hello')).toBe(2);
    });

    it('empty string returns 0', () => {
      const count = createTokenCounter('chars4');
      expect(count('')).toBe(0);
    });

    it('rounds up fractional tokens', () => {
      const count = createTokenCounter('chars4');
      // Math.ceil(3 / 4) = 1
      expect(count('abc')).toBe(1);
    });

    it('exact multiple', () => {
      const count = createTokenCounter('chars4');
      // Math.ceil(8 / 4) = 2
      expect(count('abcdefgh')).toBe(2);
    });

    it('large string', () => {
      const count = createTokenCounter('chars4');
      const text = 'a'.repeat(1000);
      // Math.ceil(1000 / 4) = 250
      expect(count(text)).toBe(250);
    });
  });

  describe('chars3 strategy', () => {
    it('divides by 3', () => {
      const count = createTokenCounter('chars3');
      // Math.ceil(5 / 3) = 2
      expect(count('hello')).toBe(2);
    });

    it('empty string returns 0', () => {
      const count = createTokenCounter('chars3');
      expect(count('')).toBe(0);
    });

    it('rounds up fractional tokens', () => {
      const count = createTokenCounter('chars3');
      // Math.ceil(2 / 3) = 1
      expect(count('ab')).toBe(1);
    });

    it('exact multiple', () => {
      const count = createTokenCounter('chars3');
      // Math.ceil(6 / 3) = 2
      expect(count('abcdef')).toBe(2);
    });

    it('large string', () => {
      const count = createTokenCounter('chars3');
      const text = 'a'.repeat(900);
      // Math.ceil(900 / 3) = 300
      expect(count(text)).toBe(300);
    });
  });

  describe('custom function strategy', () => {
    it('passes text to the custom function', () => {
      const wordCount = (text: string) => text.split(' ').length;
      const count = createTokenCounter(wordCount);
      expect(count('hello world')).toBe(2);
    });

    it('returns custom function result unchanged', () => {
      const always42 = (_text: string) => 42;
      const count = createTokenCounter(always42);
      expect(count('anything')).toBe(42);
    });

    it('custom function receives empty string', () => {
      const custom = (text: string) => text.length * 2;
      const count = createTokenCounter(custom);
      expect(count('')).toBe(0);
    });
  });

  describe('tiktoken strategy', () => {
    it('throws at creation when tiktoken is not installed', () => {
      expect(() => createTokenCounter('tiktoken')).toThrow(/tiktoken/i);
    });
  });
});
