The module `src/old-name.mjs` exports the function `oldName`.

The test file `test/name.test.mjs` imports the function `newName` from the module `src/new-name.mjs`.

Run the test file with `node --test test/name.test.mjs`.

The test fails because the module `src/new-name.mjs` does not exist.

Rename the module and its export. The function `oldName` of `src/old-name.mjs` becomes the function `newName` of `src/new-name.mjs`.

Do not change the test file.
