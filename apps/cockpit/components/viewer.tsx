"use client";

import { createContext, useContext } from "react";
import { who } from "./format";

/** The viewer's login, for pages that show logins: the Shell provides it; outside one (a test), there is no viewer. */
export const ViewerLogin = createContext<string | null>(null);

/** The viewer's own login as "you", anyone else's as it is (#105). */
export function useWho(): (login: string) => string {
  const viewer = useContext(ViewerLogin);
  return (login) => who(login, viewer);
}
