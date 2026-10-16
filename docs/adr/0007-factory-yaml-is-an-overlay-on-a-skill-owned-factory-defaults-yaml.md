# factory.yaml is an overlay on a skill-owned factory-defaults.yaml

The installer never rewrites `asf/factory.yaml`, because it is the repository's. Up to 1.2 it
stamped the whole file, about 350 lines, and so every key a stamp carried pinned its value for
good. A newer release's default never reached an existing stamp, and every upgrade was a hand-merge
of `factory.yaml.new`. The defaults also lived twice, in the template and in the pydantic models,
and the two had already drifted apart: `issues.route` had one route in code and four in the
template, and `cockpit.commands` was empty in code and four commands in the template. So a stamp
that lacked a key behaved differently from a fresh one.

Now every key, its default and its prose live in `asf/factory-defaults.yaml`. That file is the
skill's: rendered for the chosen harness, and rewritten by every run of `install.py` whenever it
differs. `asf/factory.yaml` is an overlay merged onto it and says only what differs. Maps merge key
by key, scalars and lists replace, and `null` deletes a map entry. `protected_files` and
`harness.deny_tools` only ever add, so an overlay can protect more and never less.

The models carry no defaults, which makes the defaults file the one source. A key missing from it
is a load error instead of drift between two sources. Every block forbids keys it does not have, so
a typo is refused by name instead of being dropped. Before this, `trusted_author: [me]` meant
"trust everyone".

`cockpit.commands` defaults to `[]`, and the installer writes `[answer, abort, kill, resume]` into
a new overlay. A permission a station obeys is said in the repository's own reviewed file, and an
upgrade cannot grant one.

## Considered options

- **Keep one stamped file and merge new keys in on upgrade.** Rejected. The installer would have to
  rewrite the file the operator owns, and it has no YAML parser that keeps comments. It would also
  still pin every value the file already holds.
- **Keep the defaults in the models, with no file.** Rejected. An operator reads a file, not
  `data_types.py`, and the prose that says what a key does would have nowhere to live.
- **Let the defaults grant commands.** Rejected because the stations of every stamp would start
  obeying a verb the day a release added it to the defaults, without anyone reviewing it.

## Consequences

- **Upgrades carry defaults.** A stamp that never said a key gets the new release's default on the
  next `install.py`. A stamp from before 1.3 still holds the whole file and keeps every value it
  pins until that file is shrunk to an overlay.
- **The defaults file must not be edited.** An edit holds only until the next run of the installer.
  The installer writes a digest as the file's last line, and `doctor` warns once the file no longer
  matches it.
- **Switching harness is a re-stamp.** The defaults are rendered for one harness. A `harness:` in
  the overlay that names another one inherits only the keys that mean the same on every harness, as
  an agent's block on another harness does.
