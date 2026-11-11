The module `src/greet.mjs` exports the function `shout`.

The test file `test/greet.test.mjs` imports the function `greet` from that module.

Run the test file with `node --test test/greet.test.mjs`.

The test fails because the module does not export the function that the test needs.

Add the missing export so that every test passes.

Do not change the test file.

When every test passes, call `wezterm_worker_report` once with the state `completed`. Put one sentence that names the new export in the result.
