import { redirect } from "next/navigation";

/**
 * The front door is the sage design.
 *
 * The original landing page is not deleted — it moved to /classic, so both are live and one
 * click apart. Reverting is moving two files back.
 *
 * A redirect rather than a copy of the sage page: two copies of a homepage drift, and the one
 * nobody is looking at drifts first.
 */
export default function RootPage() {
  redirect("/sage");
}
