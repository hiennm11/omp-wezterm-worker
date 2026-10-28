# The code enforces the worker limits and reports measured usage

A prompt cannot limit a model. The extension thus refuses a launch in code.
The extension returns an error that names the rule.

- At most three workers are active by default (`maxActiveWorkers`). The
  extension does not count the main session. The extension rejects a spawn
  or a resume over the limit. The extension does not put it in a queue. A
  worker with an unconfirmed stop (ADR 0006) counts as active.
- A worker cannot launch a worker. The extension finds a worker from the
  session file of the calling session, `ctx.sessionManager.getSessionFile()`.
  A worker transcript lives under `sessions/wz-…/`. This extension selects
  that path.
- The inside of the OMP build does not show the `omp` arguments in
  `process.argv`. The arguments are thus not a signal. The extension still
  shows the spawn and resume tools. The extension rejects them. The model
  gets the rule and not a missing tool.
- One request lets at most `maxLaunchesPerRequest` launches (default 3). A
  request starts at each user prompt. The counters live in memory only.
- The usage of a worker is the sum of the `usage` fields in every transcript
  under its session folder. That sum covers its own turns, the turns of its
  subagents, and the side calls that OMP logs as `model_usage` entries. A
  worker without that data shows `unknown`. A model call without usage makes
  the count `partial`.
- The extension never calculates an estimate. The extension shows a cost
  only when the transcript holds a cost above zero. A resumed worker reports
  only the turns after the resume.

The cost is that the worker detection depends on the transcript path that
this extension selects. The usage total also leaves out the main session.
