The module `src/level.mjs` exports the function `levelFor`.
The function must behave in this way:

- The function returns `high` for a score of 80 or more.
- The function returns `medium` for a score of 50 or more.
- The function returns `low` for every other score.
- The function `levelFor(75)` must return `medium`.

The module holds no test. Write the test file `test/level.test.mjs`.
The test file must import the function and must check the behaviour above.

Run the test file with `node --test test/level.test.mjs`.
The test must pass against the module that the repository holds.

Do not change the module.

When the test file exists and passes, call `wezterm_worker_report` once with the state
`completed`. Put one sentence that names the test file in the result.
