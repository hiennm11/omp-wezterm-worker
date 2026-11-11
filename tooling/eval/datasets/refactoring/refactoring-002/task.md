The module `src/text.mjs` exports the function `toUpper`.
The module `src/label.mjs` imports that function and exports the function `label`.
The test file `test/label.test.mjs` imports the function `label` and checks it.

Rename the exported function `toUpper` to `uppercase`.
Update the module `src/label.mjs` so that it imports the new name.

Keep every test passing. Do not change the test file.

When every test passes and the structure is correct, call `wezterm_worker_report` once
with the state `completed`. Put one sentence that names the change in the result.
