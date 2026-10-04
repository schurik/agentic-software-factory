import { type Facets, type Status, STATUSES } from "@/convex/model/filter";
import { type PeriodKind, PERIODS } from "@/convex/model/period";
import { who } from "../format";
import { control, cx, Field } from "../ui";

/** What a person picked in each filter: "" for any. */
export interface Choice {
  workflow: string;
  /** Who triggered the run. */
  person: string;
  /** A station's id, or `CI`. */
  station: string;
  status: Status | "";
  /** A calendar period of the viewer's own timezone. */
  period: PeriodKind | "";
}

export const ANY: Choice = { workflow: "", person: "", station: "", status: "", period: "" };

/**
 * The Sessions pages' filters (spec #40): workflow, person — who triggered
 * the run — station, status and period. The choices are what the sessions
 * looked at hold (`facetsOf`); one already picked stays offered when they no
 * longer hold it, so it can be seen and undone. `me` is the viewer's login,
 * whose own runs the person filter offers as "you".
 */
export function SessionFilters({ choice, facets, me, onChange }: {
  choice: Choice;
  facets: Facets;
  me: string;
  onChange: (choice: Choice) => void;
}) {
  const pick = (field: keyof Choice) => (value: string) => onChange({ ...choice, [field]: value });
  const people = facets.people.map((login) => ({ value: login, words: who(login, me || null) }));
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select label="Workflow" value={choice.workflow} onChange={pick("workflow")}
              options={facets.workflows.map((workflow) => ({ value: workflow, words: workflow }))} />
      <Select label="Triggered by" value={choice.person} onChange={pick("person")} options={people} />
      <Select label="Station" value={choice.station} onChange={pick("station")}
              options={facets.stations.map(({ key, name }) => ({ value: key, words: name }))} />
      <Select label="Status" value={choice.status} onChange={pick("status")}
              options={STATUSES.map((status) => ({ value: status, words: status }))} />
      <Select label="Period" value={choice.period} onChange={pick("period")} anyWords="any time"
              options={Object.entries(PERIODS).map(([value, words]) => ({ value, words }))} />
    </div>
  );
}

function Select({ label, value, options, onChange, anyWords = "any" }: {
  label: string;
  value: string;
  options: { value: string; words: string }[];
  onChange: (value: string) => void;
  anyWords?: string;
}) {
  const offered = value && !options.some((option) => option.value === value) ? [...options, { value, words: value }] : options;
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={cx(control, "min-w-32")}>
        <option value="">{anyWords}</option>
        {offered.map((option) => <option key={option.value} value={option.value}>{option.words}</option>)}
      </select>
    </Field>
  );
}
