"use client";

import { useSyncExternalStore } from "react";

/**
 * The sign-in token this browser holds (convex/auth.ts), kept in localStorage
 * so a reload stays signed in. A local cockpit never has one.
 */
const KEY = "asf.cockpit.signIn";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;      // storage blocked: signed in for as long as the page lives, no longer
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);     // signed in or out in another tab
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Keep `token` as this browser's sign-in, or forget it with null. */
export function holdSignIn(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, token);
  } catch {
    // Nothing to keep it in; the pages still work until the tab closes.
  }
  for (const listener of listeners) listener();
}

/** The token to send as `signIn` with every query, or undefined when there is none. */
export function useSignIn(): string | undefined {
  return useSyncExternalStore(subscribe, read, () => null) ?? undefined;
}

/**
 * The `state` a browser takes to the forge and expects back. It is kept per
 * tab, so a link someone else made — with their code and their state — does
 * not finish in this browser.
 */
export function carry(purpose: "sign-in" | "setup", state: string): void {
  try {
    window.sessionStorage.setItem(`asf.cockpit.${purpose}`, state);
  } catch {
    // Without it the callback refuses, which is the safe way to fail.
  }
}

export function carried(purpose: "sign-in" | "setup", state: string): boolean {
  try {
    const kept = window.sessionStorage.getItem(`asf.cockpit.${purpose}`);
    window.sessionStorage.removeItem(`asf.cockpit.${purpose}`);
    return kept !== null && kept === state;
  } catch {
    return false;
  }
}
