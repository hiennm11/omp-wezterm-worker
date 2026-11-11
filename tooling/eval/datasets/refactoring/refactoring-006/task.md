The module `src/legacy-format.mjs` exports the function `format`.
The module `src/report.mjs` imports that function and exports the function `reportLine`.
The test file `test/report.test.mjs` imports the function `reportLine` and checks it.

Rename the module `src/legacy-format.mjs` to `src/format.mjs`.
Update the module `src/report.mjs` so that it imports the module with the new name.

Keep every test passing. Do not change the test file.

When every test passes and the structure is correct, call `wezterm_worker_report` once
with the state `completed`. Put one sentence that names the change in the result.
