import { createRequire } from 'module';
import type { TokenCounterStrategy, TokenCounter } from './types.js';

export function createTokenCounter(
  strategy: TokenCounterStrategy = 'chars4'
): TokenCounter {
  if (strategy === 'chars4') {
    return (text: string) => Math.ceil(text.length / 4);
  }

  if (strategy === 'chars3') {
    return (text: string) => Math.ceil(text.length / 3);
  }

  if (typeof strategy === 'function') {
    return strategy;
  }

  // strategy === 'tiktoken'
  return createTiktokenCounter();
}

function createTiktokenCounter(): TokenCounter {
  const require = createRequire(import.meta.url);
  let tiktoken: { get_encoding: (encoding: string) => { encode: (text: string) => Uint32Array } };
  try {
    tiktoken = require('tiktoken') as typeof tiktoken;
  } catch {
    throw new Error(
      'tiktoken peer dependency is required when using the tiktoken strategy. ' +
      'Install it with: npm install tiktoken'
    );
  }
  const enc = tiktoken.get_encoding('cl100k_base');
  return (text: string) => enc.encode(text).length;
}
