// Checks the package as users get it:
// 1. `npm pack` ships only dist/, README, LICENSE, CHANGELOG and package.json;
// 2. the tarball installs into a fresh Seyfert project without legacy-peer-deps;
// 3. the published .d.ts files type-check with TypeScript 5.4 and the latest 5.x (against seyfert 5.2.0);
// 4. `import` and `require` of every entry work.
// Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const TS_VERSIONS = (process.env.BYAKU_TS_VERSIONS ?? '5.4,5.9').split(',');
const SEYFERT = process.env.BYAKU_SEYFERT ?? '5.2.0';

// When this runs inside `npm publish` (prepublishOnly), npm passes its own settings down as npm_config_*
// variables (dry-run, json output, …); our npm calls must not inherit them
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));

// npm is a .cmd file on Windows and needs a shell; node runs directly (no quoting problems)
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows && cmd === npm,
  });
const node = (args, cwd) => run(process.execPath, args, cwd);
const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
};

// 1. Files in the package
const [packInfo] = JSON.parse(run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], root));
const files = packInfo.files.map((f) => f.path.replace(/\\/g, '/'));
const allowed = (f) => f.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(f);
const unexpected = files.filter((f) => !allowed(f));
if (unexpected.length) fail(`unexpected files in the package: ${unexpected.join(', ')}`);
for (const required of [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/plugin.js',
  'dist/index.d.cts',
]) {
  if (!files.includes(required)) fail(`missing from the package: ${required}`);
}
console.log(`✔ package contents: ${files.length} files, ${(packInfo.unpackedSize / 1024).toFixed(0)} KB unpacked`);

// 2–4. Fresh project per TypeScript version
const tmp = mkdtempSync(join(tmpdir(), 'byaku-pack-'));
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', tmp, '--ignore-scripts'], root));
  const tarball = join(tmp, packed.filename);
  for (const ts of TS_VERSIONS) {
    const dir = join(tmp, `ts-${ts}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
    );
    // No .npmrc here: peers must resolve without legacy-peer-deps
    run(
      npm,
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps=false',
        tarball,
        `seyfert@${SEYFERT}`,
        `typescript@${ts}`,
        '@types/node@20',
      ],
      dir,
    );
    copyFileSync(join(root, 'test/fixtures/consumer/index.ts'), join(dir, 'index.ts'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          types: ['node'],
          // Check Byaku's .d.ts files too (Seyfert's own errors on old TypeScript are reported separately)
          skipLibCheck: false,
        },
        include: ['index.ts'],
      }),
    );
    let output = '';
    try {
      output = node([join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], dir);
    } catch (err) {
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const errors = output.split('\n').filter((l) => /error TS\d+/.test(l));
    const ours = errors.filter((l) => !/node_modules[\\/](seyfert|@types)[\\/]/.test(l));
    const theirs = errors.length - ours.length;
    const version = JSON.parse(readFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
    if (ours.length)
      fail(`TypeScript ${version}: ${ours.length} error(s) in Byaku or the example:\n${ours.join('\n')}`);
    else
      console.log(
        `✔ TypeScript ${version}: Byaku's types check${theirs ? ` (${theirs} error(s) inside seyfert's own .d.ts with this TypeScript, not Byaku's)` : ''}`,
      );

    // Runtime: ESM and CJS entries
    node(
      [
        '--input-type=module',
        '-e',
        "import { Byaku, defineMode } from 'byaku'; import { byakuPlugin } from 'byaku/plugin'; import { createByakuClasses } from 'byaku'; if (typeof Byaku !== 'function' || typeof byakuPlugin !== 'function' || typeof createByakuClasses !== 'function' || typeof defineMode !== 'function') process.exit(1);",
      ],
      dir,
    );
    node(
      [
        '-e',
        "const { Byaku } = require('byaku'); const { byakuPlugin } = require('byaku/plugin'); const { createByakuClasses } = require('byaku'); if (typeof Byaku !== 'function' || typeof byakuPlugin !== 'function' || typeof createByakuClasses !== 'function') process.exit(1);",
      ],
      dir,
    );
    console.log(`✔ import and require work (TypeScript ${version} project)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (process.exitCode) console.error('Package check failed.');
else console.log('Package check passed.');
