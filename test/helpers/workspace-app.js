const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require.resolve('../../public/app.js'), 'utf8');

// Execute the shipped entry functions together. Only browser/network surfaces
// and unrelated renderers are supplied by the fixture; navigation is real.
module.exports = function appFunctions(context, names) {
  const functions = names.map(name => {
    const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(marker, name);
    return source.slice(marker.index, source.indexOf('\n}', marker.index) + 2);
  }).join('\n');
  vm.createContext(context);
  vm.runInContext(functions, context);
  return context;
};
