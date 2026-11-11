The module `src/prefix.mjs` exports the function `hasPrefix`.
The function must behave in this way:

- The function returns true when the text starts with the prefix.
- The function returns no value for every other text.
- The function `hasPrefix("report", "re")` must return true.
- The function `hasPrefix("report", "port")` must not return true.

The module holds no test. Write the test file `test/prefix.test.mjs`.
The test file must import the function and must check the behaviour above.

Run the test file with `node --test test/prefix.test.mjs`.
The test must pass against the module that the repository holds.

Do not change the module.

When the test file exists and passes, call `wezterm_worker_report` once with the state
`completed`. Put one sentence that names the test file in the result.
