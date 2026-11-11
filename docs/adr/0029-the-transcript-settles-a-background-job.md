# The transcript settles a background job that OMP moved to the background

Status: accepted design. The runtime follows this contract.

## Context

A worker runs a command that takes longer than 60 seconds. OMP moves the
command to the background and gives the worker a job id. The result of the
call names the job.

The extension opened an execution row for that call. The row stayed open,
because the extension read the end of a job from one shape only. The
extension then refused the completion report of the worker for ever.

The issue 197 shows the result. The run `wz-mwbn1im8-3` held 292 rows. 287
rows were settled and 5 rows were open. The 5 rows held the jobs `bg_5`,
`bg_6`, `bg_7`, `bg_10` and `bg_11`. The report of the worker said
`completed`, and the status tool said that 5 executions were still
outstanding.

The cause was the shape of the transcript. The result of the call holds the
job under the key `async`. The end of the job arrived in an `async-result`
entry with the key `jobs`, in the result of the tool `wait` with the key
`id`, in the result of a read of `proc://bg_N` with the key `proc`, and in
the result of a kill of that job with the key `proc`. The parser read the
first two shapes only.

## The decision

The ledger collects the status of a background job from every shape that
holds one. The shapes are these.

- The tool result of the call that started the job. The key `async` holds the
  job id and the key `state` holds its status.
- The follow-up entry that OMP writes when the job ends. The key `jobs`
  holds the job id under the key `jobId`.
- The result of the tool `wait`. The key `jobs` holds the job id under the
  key `id`.
- The result of a read of `proc://bg_N`. The key `proc` holds the job under
  the key `job`.
- The result of a kill of that job. The key `proc` holds the jobs under the
  key `jobs`.

A job settles its row only when one of these shapes holds a terminal status.
The terminal statuses stay `completed`, `failed` and `cancelled`. The
extension never guesses that a job ended.

A job without a terminal status keeps its row open. The completion blocker
then names the job id and the command of the call that started it, so the
owner sees what to act on. The start evidence of the row holds the command
next to the turn.

The parser of the calls keeps the shape of the entry `async-result`. The
support of the key `jobs` stays as it is.

## The tradeoffs

The parser reads more shapes. A shape that a future host changes breaks the
settlement of that job. The row stays open in that case, so the failure is
visible and not silent.

The blocker names the open rows of a background job. The text grows when
many jobs wait. The owner needs those names, because the worker cannot
repair the rows itself.

The extension reads no file outside the transcript. A job that ends without
a trace in the transcript keeps its row open. The owner resolves that row
with `wezterm_worker_resolve`.

The schema of the database does not change. The command of a call stays in
the start evidence of the row, which the schema already holds.
