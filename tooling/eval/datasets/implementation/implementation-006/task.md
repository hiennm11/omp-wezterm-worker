The module `src/parse-duration.mjs` does not export the function `parseDuration`.

The test file `test/parse-duration.test.mjs` imports that function and checks it.

Run the test file with `node --test test/parse-duration.test.mjs`.

The test fails because the module does not export the function that the test needs.

Add the function `parseDuration` to the module so that every test passes.

Do not change the test file.

When every test passes, call `wezterm_worker_report` once with the state `completed`.
Put one sentence that names the new export in the result.
