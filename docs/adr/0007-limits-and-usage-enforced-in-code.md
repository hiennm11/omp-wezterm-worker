# The code enforces the worker limits and reports measured usage

A prompt cannot limit a model. The extension therefore refuses a launch in
code and returns an error that names the rule.

- At most three workers are active by default (`maxActiveWorkers`). The main
  session is not counted. A spawn or a resume over the limit is rejected, not
  queued. A worker whose stop is not confirmed (ADR 0006) counts as active.
- A worker cannot launch a worker. The extension detects a worker from the
  session file of the calling session, `ctx.sessionManager.getSessionFile()`.
  A worker transcript lives under `sessions/wz-…/`, a path that this extension
  chooses. The inside of the compiled OMP does not show the `omp` arguments in
  `process.argv`, so the arguments are not a signal. The extension still
  registers the spawn and resume tools, and it rejects them, so the model gets
  the rule and not a missing tool.
- One request allows at most `maxLaunchesPerRequest` launches (default 3). A
  request starts at each user prompt. The counters live in memory only.
- The usage of a worker is the sum of the `usage` fields in every transcript
  under its session folder. That covers its own turns, the turns of its
  subagents, and the side calls that OMP logs as `model_usage` entries. A
  worker without that data shows `unknown`. A model call without usage makes
  the count `partial`. The extension never computes an estimate. It shows a
  cost only when the transcript holds a cost above zero. A resumed worker
  reports only the turns after the resume.

The cost is that the worker detection depends on the transcript path that this
extension chooses. The usage total also leaves out the main session.
