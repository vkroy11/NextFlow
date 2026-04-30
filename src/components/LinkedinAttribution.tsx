"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Emits exactly one `[NextFlow] Candidate LinkedIn: <url>` console.log on
 * the initial client render of every page. The URL is read server-side from
 * `CANDIDATE_LINKEDIN_URL` and threaded down as a prop, so the env var does
 * not need a `NEXT_PUBLIC_` prefix.
 *
 * The effect's `pathname` dependency re-fires on route changes so SPA
 * navigation also produces a fresh log line.
 */
export function LinkedinAttribution({ url }: { url: string }) {
  const pathname = usePathname();
  useEffect(() => {
    if (typeof window === "undefined") return;
    console.log(`[NextFlow] Candidate LinkedIn: ${url}`);
    // pathname is intentionally a dep so each route landing emits the line.
  }, [pathname, url]);
  return null;
}
