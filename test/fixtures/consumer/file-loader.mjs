// Run against the installed tarball, using Seyfert's actual filesystem loaders.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ComponentCommand, ModalCommand } from 'seyfert';

// Keep the files inside the consumer so their package imports resolve to the installed dependencies.
const root = mkdtempSync(join(import.meta.dirname, 'file-loader-'));
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'shared.js'),
    `import { Client } from 'seyfert';
import { Byaku, createByakuClasses } from 'byaku';
export const client = new Client();
export const byaku = new Byaku(client, { owners: ['123'] });
export const classes = createByakuClasses(byaku);
`,
  );
  for (const dir of ['components', 'commands', 'arrays']) mkdirSync(join(root, dir));
  for (const name of ['ByakuButtons', 'ByakuSelects', 'ByakuModal']) {
    writeFileSync(
      join(root, 'components', `${name}.js`),
      `import { classes } from '../shared.js';\nexport default classes.${name};\n`,
    );
  }
  writeFileSync(
    join(root, 'commands', 'byaku.js'),
    "import { classes } from '../shared.js';\nexport default classes.ByakuCommand;\n",
  );
  for (const name of ['ByakuComponents', 'ByakuModals']) {
    writeFileSync(
      join(root, 'arrays', `${name}.js`),
      `import { classes } from '../shared.js';\nexport default classes.${name};\n`,
    );
  }
  const { client, classes } = await import(pathToFileURL(join(root, 'shared.js')).href);

  // Reproduce the unsupported recommendation: arrays silently register no handlers.
  await client.components.load(join(root, 'arrays'));
  assert.equal(client.components.commands.length, 0);

  await client.components.load(join(root, 'components'));
  assert.equal(client.components.commands.length, 3);
  for (const name of ['ByakuButtons', 'ByakuSelects', 'ByakuModal']) {
    const loaded = client.components.commands.filter((handler) => handler instanceof classes[name]);
    assert.equal(loaded.length, 1, `${name} must load exactly once`);
    assert.equal(loaded[0].__filePath, join(root, 'components', `${name}.js`));
  }
  const buttons = client.components.commands.find((handler) => handler instanceof classes.ByakuButtons);
  const selects = client.components.commands.find((handler) => handler instanceof classes.ByakuSelects);
  assert.ok(buttons instanceof ComponentCommand);
  assert.equal(buttons.componentType, 'Button');
  assert.ok(selects instanceof ComponentCommand);
  assert.equal(selects.componentType, 'StringSelect');
  assert.ok(client.components.commands.some((handler) => handler instanceof ModalCommand));

  await client.commands.load(join(root, 'commands'), client);
  assert.equal(client.commands.values.length, 1);
  assert.ok(client.commands.values[0] instanceof classes.ByakuCommand);
  assert.equal(client.commands.values[0].name, 'byaku');

  // Existing direct registration consumers retain their constructor-array API.
  const direct = new client.constructor();
  direct.components.set([...classes.ByakuComponents, ...classes.ByakuModals]);
  assert.equal(direct.components.commands.length, 3);
  for (const name of ['ByakuButtons', 'ByakuSelects', 'ByakuModal']) {
    assert.equal(direct.components.commands.filter((handler) => handler instanceof classes[name]).length, 1);
  }
  console.log('✔ file loaders: three individual handlers and optional command load; direct arrays remain supported');
} finally {
  rmSync(root, { recursive: true, force: true });
}
