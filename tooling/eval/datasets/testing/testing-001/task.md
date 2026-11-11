The module `src/tax.mjs` exports the function `taxFor`.
The function must behave in this way:

- The function returns ten percent of the given sum.
- The function `taxFor(100)` must return 10.
- The function `taxFor(0)` must return 0.

The module holds no test. Write the test file `test/tax.test.mjs`.
The test file must import the function and must check the behaviour above.

Run the test file with `node --test test/tax.test.mjs`.
The test must pass against the module that the repository holds.

Do not change the module.

When the test file exists and passes, call `wezterm_worker_report` once with the state
`completed`. Put one sentence that names the test file in the result.
