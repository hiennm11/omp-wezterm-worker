The module `src/command.mjs` exports the function `runCommand`.
The function doubles a number when the text starts with `double`.
The function returns the number itself for every other text.
The test file `test/command.test.mjs` imports the function `runCommand` and checks it.

Split the function `runCommand` into the exported function `parseCommand` and the exported
function `applyCommand`.
The function `parseCommand` reads the text. The function `applyCommand` uses the result.
The function `runCommand` must call the two new functions.

Keep every test passing. Do not change the test file.

When every test passes and the structure is correct, call `wezterm_worker_report` once
with the state `completed`. Put one sentence that names the change in the result.
