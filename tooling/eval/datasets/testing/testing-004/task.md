The module `src/even.mjs` exports the function `isEven`.
The function must behave in this way:

- The function returns true for an even number.
- The function returns no value for an odd number.
- The function `isEven(4)` must return true.
- The function `isEven(7)` must not return true.

The module holds no test. Write the test file `test/even.test.mjs`.
The test file must import the function and must check the behaviour above.

Run the test file with `node --test test/even.test.mjs`.
The test must pass against the module that the repository holds.

Do not change the module.

When the test file exists and passes, call `wezterm_worker_report` once with the state
`completed`. Put one sentence that names the test file in the result.
