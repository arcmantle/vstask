import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('baseline.json', root), 'utf8'));

for (const file of baseline.files) {
  const content = readFileSync(new URL(file.local, root));
  const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  if (actual !== file.blob) {
    throw new Error(`Upstream file changed: ${file.local}. Review the baseline update.`);
  }
}

function checkCoreImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) {
      checkCoreImports(location);
    } else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(location, 'utf8');
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        if (imported.fileName === 'vscode' || imported.fileName.startsWith('vscode/')) {
          throw new Error(`Core imports the VS Code API: ${fileURLToPath(location)}`);
        }
      }
    }
  }
}

checkCoreImports(new URL('packages/core/src/', root));
console.log(`Verified ${baseline.files.length} upstream files at ${baseline.commit}.`);
console.log('Core has no VS Code API import. This stage is not release-ready.');