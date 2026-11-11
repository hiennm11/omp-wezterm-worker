The module `src/clamp.mjs` does not export the function `clamp`.

The test file `test/clamp.test.mjs` imports that function and checks it.

Run the test file with `node --test test/clamp.test.mjs`.

The test fails because the module does not export the function that the test needs.

Add the function `clamp` to the module so that every test passes.

Do not change the test file.

When every test passes, call `wezterm_worker_report` once with the state `completed`.
Put one sentence that names the new export in the result.
