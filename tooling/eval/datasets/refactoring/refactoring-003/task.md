The module `src/strings.mjs` exports the functions `titleCase` and `slugify`.
The module `src/report.mjs` imports the function `titleCase` and exports the function `reportTitle`.
The test file `test/strings.test.mjs` imports the function `slugify` and the function `reportTitle`.

Move the function `titleCase` to a new module `src/title-case.mjs`.
Update the module `src/report.mjs` so that it imports the function from the new module.
The module `src/strings.mjs` must not define the function `titleCase` any more.

Keep every test passing. Do not change the test file.

When every test passes and the structure is correct, call `wezterm_worker_report` once
with the state `completed`. Put one sentence that names the change in the result.
