The module `src/port.mjs` exports the function `parsePort`.
The function returns a number for a whole text and returns `null` for every other text.
The test file `test/port.test.mjs` imports the function `parsePort` and checks it.

Extract the branch that refuses a text into a new exported function `isValidPort`.
The function `parsePort` must call the function `isValidPort`.

Keep every test passing. Do not change the test file.

When every test passes and the structure is correct, call `wezterm_worker_report` once
with the state `completed`. Put one sentence that names the change in the result.
