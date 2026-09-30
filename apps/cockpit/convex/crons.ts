import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The forge catch-up poll (discovery.ts). In a local cockpit it is the only
// way anything is learned of the forge — GitHub cannot reach localhost — and
// in a team's it is what catches the webhook delivery GitHub sent once and
// never retried. Every minute is affordable in both: it asks with ETags, and
// a round that finds nothing changed is all 304s, which cost nothing against
// the rate limit. `docker/start.sh` runs the same function once as the
// deployment starts, so a cockpit that was down catches up before the first
// minute is out.
crons.interval("forge catch-up", { minutes: 1 }, internal.discovery.catchUp, {});

export default crons;
