const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const coreRolesRoutePath = path.join(projectRoot, 'routes', 'coreRolesRoutes.js');
const roleImportServicePath = path.join(projectRoot, 'modules', 'roleImportService.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('core role routes expose runtime role APIs but not product import-source catalog APIs', () => {
  const routeSource = readSource(coreRolesRoutePath);

  assert.match(routeSource, /router\.get\('\/roles'/);
  assert.match(routeSource, /router\.post\('\/roles\/import'/);
  assert.doesNotMatch(routeSource, /roleImportService/);
  assert.doesNotMatch(routeSource, /\/import-sources/);
});

test('product import-source scanning service is not part of VCPToolBox core', () => {
  assert.equal(
    fs.existsSync(roleImportServicePath),
    false,
    'PromptX/agency-agents source scanning belongs in the product layer, not VCPToolBox core'
  );
});
