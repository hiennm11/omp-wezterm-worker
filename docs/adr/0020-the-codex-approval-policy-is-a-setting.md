# The approval policy of a Codex worker is a setting

Status: superseded by ADR 0026. The Codex backend was removed.

The extension starts a turn of a Codex worker without the field `approvalPolicy`.
The turn then takes the policy `never` of the config of the user, and no command asks the person for an approval.

The config file `wezterm-worker.json` gets the section `codex`. The key `codex.approvalPolicy` names the policy of a Codex worker.
The values are `untrusted`, `on-request` and `never`.
The default is no value. The extension then sends no field, and the worker keeps the policy of the user.
The behavior of every running worker stays the same.

The extension sends the field `approvalPolicy` in the request `thread/start` and in the request `turn/start`.
The extension sends the field only when the setting names a policy.
The request `thread/resume` sends no field, because the thread of the source run already holds its policy.

The extension refuses an unknown policy when it reads the config file.
The refusal names the setting, the value and the valid policies.
The extension then uses no policy, and the worker keeps the policy of the user.
A wrong value must not break the extension, and it must not pass without a word.

The extension never answers a native dialog.
The person answers the approval in the pane of the TUI.
The extension records the event `permission_request` for the owner, and the owner sees the request in the status.

The smoke test starts the worker of the step of the permission request with the policy `untrusted`.
That policy applies to that worker only. The other workers of the smoke test keep the policy of the user.
The step starts no second turn on the thread of the worker.
The step never sends a key to the pane.
The step shows that the status tool lists one event of the request, and that a second poll creates no second event.
The step ends the worker with a cancel.

The measurement of 2026-11-05 showed that this design works.
The extension started a turn with the policy `untrusted` through the app server of Codex.
The client of the extension received the request `item/commandExecution/requestApproval`.
The TUI of the worker showed the dialog "Would you like to run the following command?".
The request of the approval reaches the client that started the turn, and the TUI shows the same request as a dialog.

The spec of the app server of Codex accepts the values of this list.
The build codex-cli 0.166.0 defines the type `AskForApproval` as `untrusted`, `on-request`, a granular form and `never`.
The extension sends the three values of the list. It sends no granular form, because a user has no use for it.
