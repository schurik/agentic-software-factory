# Measurement runs on the station; self-improvement goes through the tracker

A factory measures its own work the way Warp Factories does: scorers, benchmarks, metrics and
self-improvement. But it does not borrow Warp's shape, where one hosted service judges every run and
opens pull requests against the factory. A scorer's model is an agent, and a cockpit never runs a
factory's agents and is optional besides. So scoring runs on the station, under the factory's own
permissions and a `measurement:` budget of its own. Its score is a domain event appended to the
judged session's record, and the cockpit only shows it.

A score never changes the outcome of the chapter it judges: a scorer measures, a gate decides, and a
criterion that must block work is rewritten as a gate in Python. Repeated failing scores do not
become a pull request. They become an issue on the factory's own tracker, holding the evidence and a
diagnosis, and that issue is worked by the ordinary issue workflow with a person approving its
plan. This keeps "code owns acceptance" true when the judge is a model, and it reuses every workflow
the factory already has. Nothing the factory learns about itself changes it without a person
merging the change.

## Considered options

- **Score in the cockpit.** Rejected because it would make the cockpit run agents. It would also
  leave a factory without a cockpit unable to measure anything.
- **Self-improvement opens pull requests directly, as Warp's does.** Rejected for two reasons. The
  change would arrive with no reviewed plan. And an edit to a skill-owned file would be lost on the
  next `install.py --force`, where an issue can say "carry this upstream" instead.
- **Let a failing score fail the chapter or block `integrate`.** Rejected because a model's opinion
  would then decide acceptance, which only a gate's check of a claim against what actually happened
  may do.

## Consequences

- **Late events.** A session's events can now arrive after `session_finished`: scores, and the
  `pull_request_closed` its watcher emits. A cockpit accepts late events on a finished session.
- **Merges come from events.** Merge state and autonomy reach the cockpit as domain events emitted
  by the station, never by the cockpit asking the forge, so every view is still built from domain
  events.
- **Self-improvement needs no shared state but the tracker.** Two stations deduplicate through one
  open issue per scorer, found by its label.
