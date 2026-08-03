import {
  buildDelexCommand,
  executeCommand,
  tryReplyNumber,
} from './utils/index.ts';

import type { CommandDelexOptions } from '../index.ts';

export function createCommand(key: string, options?: CommandDelexOptions) {
  return buildDelexCommand(key, options);
}

export async function delex<T>(
  this: T,
  key: string,
  options?: CommandDelexOptions,
): Promise<number> {
  return await executeCommand(
    this,
    createCommand(key, options),
    tryReplyNumber,
  );
}
