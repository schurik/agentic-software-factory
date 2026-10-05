/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as claims from "../claims.js";
import type * as commands from "../commands.js";
import type * as config from "../config.js";
import type * as cost from "../cost.js";
import type * as crons from "../crons.js";
import type * as describe from "../describe.js";
import type * as diffs from "../diffs.js";
import type * as discovery from "../discovery.js";
import type * as factories from "../factories.js";
import type * as factory from "../factory.js";
import type * as forge_app from "../forge/app.js";
import type * as forge_forge from "../forge/forge.js";
import type * as forge_github from "../forge/github.js";
import type * as forge_memory from "../forge/memory.js";
import type * as forge_open from "../forge/open.js";
import type * as forge_token from "../forge/token.js";
import type * as handshakes from "../handshakes.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as ingest from "../ingest.js";
import type * as model_answer from "../model/answer.js";
import type * as model_attention from "../model/attention.js";
import type * as model_claim from "../model/claim.js";
import type * as model_command from "../model/command.js";
import type * as model_config from "../model/config.js";
import type * as model_description from "../model/description.js";
import type * as model_digest from "../model/digest.js";
import type * as model_drift from "../model/drift.js";
import type * as model_factories from "../model/factories.js";
import type * as model_filter from "../model/filter.js";
import type * as model_gate from "../model/gate.js";
import type * as model_graph from "../model/graph.js";
import type * as model_inbox from "../model/inbox.js";
import type * as model_journal from "../model/journal.js";
import type * as model_mode from "../model/mode.js";
import type * as model_payload from "../model/payload.js";
import type * as model_period from "../model/period.js";
import type * as model_phase from "../model/phase.js";
import type * as model_progress from "../model/progress.js";
import type * as model_ranges from "../model/ranges.js";
import type * as model_retention from "../model/retention.js";
import type * as model_session from "../model/session.js";
import type * as model_spend from "../model/spend.js";
import type * as model_story from "../model/story.js";
import type * as model_trigger from "../model/trigger.js";
import type * as model_webhook from "../model/webhook.js";
import type * as model_wire from "../model/wire.js";
import type * as now from "../now.js";
import type * as retention from "../retention.js";
import type * as sessions from "../sessions.js";
import type * as setup from "../setup.js";
import type * as spelling from "../spelling.js";
import type * as stations from "../stations.js";
import type * as tokens from "../tokens.js";
import type * as trigger from "../trigger.js";
import type * as viewer from "../viewer.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  artifacts: typeof artifacts;
  auth: typeof auth;
  claims: typeof claims;
  commands: typeof commands;
  config: typeof config;
  cost: typeof cost;
  crons: typeof crons;
  describe: typeof describe;
  diffs: typeof diffs;
  discovery: typeof discovery;
  factories: typeof factories;
  factory: typeof factory;
  "forge/app": typeof forge_app;
  "forge/forge": typeof forge_forge;
  "forge/github": typeof forge_github;
  "forge/memory": typeof forge_memory;
  "forge/open": typeof forge_open;
  "forge/token": typeof forge_token;
  handshakes: typeof handshakes;
  http: typeof http;
  inbox: typeof inbox;
  ingest: typeof ingest;
  "model/answer": typeof model_answer;
  "model/attention": typeof model_attention;
  "model/claim": typeof model_claim;
  "model/command": typeof model_command;
  "model/config": typeof model_config;
  "model/description": typeof model_description;
  "model/digest": typeof model_digest;
  "model/drift": typeof model_drift;
  "model/factories": typeof model_factories;
  "model/filter": typeof model_filter;
  "model/gate": typeof model_gate;
  "model/graph": typeof model_graph;
  "model/inbox": typeof model_inbox;
  "model/journal": typeof model_journal;
  "model/mode": typeof model_mode;
  "model/payload": typeof model_payload;
  "model/period": typeof model_period;
  "model/phase": typeof model_phase;
  "model/progress": typeof model_progress;
  "model/ranges": typeof model_ranges;
  "model/retention": typeof model_retention;
  "model/session": typeof model_session;
  "model/spend": typeof model_spend;
  "model/story": typeof model_story;
  "model/trigger": typeof model_trigger;
  "model/webhook": typeof model_webhook;
  "model/wire": typeof model_wire;
  now: typeof now;
  retention: typeof retention;
  sessions: typeof sessions;
  setup: typeof setup;
  spelling: typeof spelling;
  stations: typeof stations;
  tokens: typeof tokens;
  trigger: typeof trigger;
  viewer: typeof viewer;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
