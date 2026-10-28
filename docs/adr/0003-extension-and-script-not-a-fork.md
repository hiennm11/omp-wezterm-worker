# An extension and a script, not a change to OMP core

An OMP extension and a small install script spawn the workers. The project
does not patch OMP and it does not fork OMP. The extension registers the tools.
The script links the plugin, writes the config file and installs the skill.

This design keeps the project a plugin. The project works against a released
OMP. The project upgrades by upgrading OMP. An OMP release cannot break the
project.

The cost is that anything OMP does not expose as an extension API is out of
reach. The `sendMessage` delivery options are undocumented in the published
type stub. A delivery that silently does nothing is easy to miss.

We rejected the alternative of forking OMP to expose worker spawning natively.
That alternative would tie every user to a custom OMP build. The
feature fits the extension surface.
