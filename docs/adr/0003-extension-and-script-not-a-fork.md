# An extension and a script, not a change to OMP core

Workers are spawned by an OMP extension plus a small install script, not by
patching or forking OMP itself. The extension registers the tools; the script
links the plugin, writes the config file and installs the skill.

This keeps the project a plugin: it works against a released OMP, it upgrades
by upgrading OMP, and it cannot be broken by an OMP release. The cost is that
anything OMP does not expose as an extension API is out of reach — the
`sendMessage` delivery options are undocumented in the published type stub,
and a delivery that silently does nothing is easy to miss.

The alternative, forking OMP to expose worker spawning natively, was rejected:
it would tie every user to a custom OMP build for a feature that fits the
extension surface.
