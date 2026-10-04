const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
	const root = await mkdtemp(path.join(tmpdir(), 'vstask-extension-'));
	const userData = await mkdtemp(path.join(tmpdir(), 'vstask-extension-profile-'));
	try {
		await mkdir(path.join(root, '.vscode'));
		const workspace = path.join(root, 'test.code-workspace');
		await writeFile(workspace, JSON.stringify({ folders: [{ path: root }] }));
		await mkdir(path.join(root, 'nested', '.vscode'), { recursive: true });
		await writeFile(path.join(root, 'nested', '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
			{ label: 'unselected input', type: 'process', command: '${input:missing}' },
		] }));
		await writeFile(path.join(root, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
			{ label: 'native process', type: 'process', command: process.execPath, args: ['probe.cjs', 'process', '0'] },
			{ label: 'native shell', type: 'shell', command: process.execPath, args: ['probe.cjs', 'shell', '7'] },
			{ label: 'custom shell', type: 'shell', command: process.execPath,
				args: ['probe.cjs', 'custom', '3'], options: { shell: process.platform === 'win32'
					? { executable: 'cmd.exe', args: ['/d', '/c'], quoting: { strong: '"' } }
					: { executable: '/bin/bash', args: ['-c'], quoting: { strong: "'" } } } },
		] }));
		await writeFile(path.join(root, 'probe.cjs'), 'const fs=require("node:fs");const result={value:process.argv[2],cwd:process.cwd()};console.log(JSON.stringify(result));fs.writeFileSync(process.argv[2]+".json",JSON.stringify(result));process.exit(Number(process.argv[3]));');
		await runTests({ version: '1.105.1', extensionDevelopmentPath: path.resolve(__dirname, '../../packages/vscode-extension'),
			extensionTestsPath: path.join(__dirname, 'suite.cjs'), launchArgs: [workspace, '--user-data-dir', userData,
				'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
			extensionTestsEnv: { VSTASK_TEST_ROOT: root, VSTASK_TEST_NODE: process.execPath } });
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(userData, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });