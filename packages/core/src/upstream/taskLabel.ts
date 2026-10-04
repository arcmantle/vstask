/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function readTaskLabel(external: Record<string, unknown>, version: unknown): string | undefined {
  let taskName = external.taskName;
  if (typeof external.label === 'string' && version !== '0.1.0') {
    taskName = external.label;
  }
  return typeof taskName === 'string' && taskName ? taskName : undefined;
}